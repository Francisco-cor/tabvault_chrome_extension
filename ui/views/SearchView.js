// ui/views/SearchView.js — Búsqueda sobre el índice invertido (Fase 7.1).
// El motor vive en core/searchIndex.js (mantenimiento incremental + ranking);
// esta vista renderiza solo cuando cambia query/sesiones y añade chips de
// operadores clickeables (domain:/tag:/in:name|url|notes/"frase").
// El debounce de 80ms vive en events.js; el índice se sincroniza solo.

import { searchVault } from '../../core/searchIndex.js';
import { formatRelativeTime, truncateUrl } from '../../shared/utils.js';
import { Icon } from '../components/Icon.js';
import { favIconHtml } from '../components/Favicon.js';
import { escapeHtml, escapeAttr } from '../render.js';

/** Chips de operadores insertables con un click. */
const OPERATOR_CHIPS = [
  { label: 'domain:', op: 'domain:', title: 'Filter by tab domain — domain:github.com' },
  { label: 'tag:', op: 'tag:', title: 'Match sessions carrying a tag — tag:work' },
  { label: 'in:name', op: 'in:name ', title: 'Next term matches session names only' },
  { label: 'in:url', op: 'in:url ', title: 'Next term matches tab URLs only' },
  { label: 'in:notes', op: 'in:notes ', title: 'Next term matches notes only' },
  { label: '"…"', op: '"', title: 'Exact phrase match' },
];

export const SearchView = {
  deps: (/** @type {any} */ state) => [
    state.searchQuery,
    state.sessions,
    Math.floor(state.now / 60000),
    state.historyResults,
    state.settings?.historyEnabled,
    state.favicons,
  ],

  /** @param {any} state */
  render(state) {
    const chips = `
      <div class="search-chips" role="toolbar" aria-label="Search operators">
        ${OPERATOR_CHIPS.map(
          (c) => `<button class="tag-filter-chip mini" data-action="insert-operator"
            data-op="${escapeHtml(c.op)}" title="${escapeHtml(c.title)}">${escapeHtml(c.label)}</button>`
        ).join('')}
      </div>`;
    const resultsHtml = state.searchQuery.trim() ? results(state) : recentSessions(state);
    const historyHtml = state.searchQuery.trim() && state.settings?.historyEnabled ? historyBlock(state) : '';
    return `
    <div class="search-bar">
      ${Icon('search', 14)}
      <input data-fk="search-input" class="search-input" type="search"
        placeholder="Search tabs, sessions, tags…"
        value="${escapeAttr(state.searchQuery)}" autocomplete="off" spellcheck="false"
        aria-label="Search tabs, sessions and tags"
        data-action="search-input">
    </div>
    ${chips}
    <div id="search-results">${resultsHtml}</div>
    ${historyHtml}`;
  },
};

/** @param {any} state */
function results(state) {
  // Ranking combinado del índice: texto + frescura + pinned + frecuencia de apertura.
  const found = searchVault(state.sessions, state.searchQuery, { now: state.now });
  if (found.length === 0) {
    return `
    <div class="empty-state">
      ${Icon('search', 36, 'class="empty-icon" stroke-width="1.2"')}
      <h4>No results</h4>
      <p>Try different keywords or an operator like domain:github.com</p>
    </div>`;
  }

  const countLine = `<div class="search-count">${found.length} session${found.length !== 1 ? 's' : ''}</div>`;

  return (
    countLine +
    found
      .map((/** @type {any} */ session) => {
        const matchingTabs = (session._matchingTabs ?? []).slice(0, 8);
        if (matchingTabs.length === 0) {
          return `
        <div class="search-result-group">
          <div class="search-result-session">${escapeHtml(session.name)}</div>
          ${allTabsFor(session, state.favicons)}
        </div>`;
        }
        return `
        <div class="search-result-group">
          <div class="search-result-session">${escapeHtml(session.name)}</div>
          ${matchingTabs.map((/** @type {any} */ t) => tabLink(t, state.favicons)).join('')}
        </div>`;
      })
      .join('')
  );
}

/** @param {any} tab @param {any} favicons */
function tabLink(tab, favicons) {
  return `
      <a class="search-tab-item" href="${safeHref(tab.url)}" target="_blank" title="${escapeAttr(tab.title)} ${escapeAttr(tab.url)}">
        ${favIconHtml(tab.url, favicons, { size: 14 })}
        <div class="search-tab-info">
          <div class="search-tab-title">${escapeHtml(tab.title || tab.url)}</div>
          <div class="search-tab-meta">
            <span class="search-tab-url">${escapeHtml(truncateUrl(tab.url))}</span>
            <span class="meta-dot"></span>
            <span>${escapeHtml(tab._groupName ?? '')}</span>
          </div>
        </div>
      </a>`;
}

/**
 * Tabs de una sesión sin matches de tabs (match por nombre/tags).
 * @param {any} session
 * @param {any} favicons
 */
function allTabsFor(session, favicons) {
  const allTabs = [
    ...(session.ungroupedTabs ?? []),
    ...(session.groups ?? []).flatMap((/** @type {any} */ g) => g.tabs ?? []),
  ].slice(0, 6);

  return allTabs
    .map(
      (/** @type {any} */ tab) => `
      <a class="search-tab-item" href="${safeHref(tab.url)}" target="_blank">
        ${favIconHtml(tab.url, favicons, { size: 14 })}
        <div class="search-tab-info">
          <div class="search-tab-title">${escapeHtml(tab.title || tab.url)}</div>
          <div class="search-tab-meta"><span class="search-tab-url">${escapeHtml(truncateUrl(tab.url))}</span></div>
        </div>
      </a>`
    )
    .join('');
}

/** @param {any} state */
function recentSessions(state) {
  const sessions = Object.values(state.sessions)
    .sort((/** @type {any} */ a, /** @type {any} */ b) => b.updated - a.updated)
    .slice(0, 3);
  if (sessions.length === 0) {
    return `<p class="text-dim" style="text-align:center;margin-top:32px;font-size:12px">No saved sessions to search.</p>`;
  }

  return (
    `<div style="font-size:11px;color:var(--text-dim);margin-bottom:8px">Recent sessions</div>` +
    sessions
      .map(
        (/** @type {any} */ session) => `
      <div class="search-result-group">
        <div class="search-result-session">${escapeHtml(session.name)} <span style="font-weight:400;text-transform:none;letter-spacing:0">${formatRelativeTime(session.updated)}</span></div>
        ${allTabsFor(session, state.favicons)}
      </div>`
      )
      .join('')
  );
}

/** @param {any} state */
function historyBlock(state) {
  const items = state.historyResults ?? [];
  if (items.length === 0) {
    // No bloque si no hay resultados; evita ruido. Muestra solo cuando hay algo o query activa.
    // Si quieres feedback, descomenta: return '<div class="text-muted" style="font-size:11px;margin-top:12px">No history matches</div>';
    return '';
  }
  return `
  <div class="search-history-block" style="margin-top:16px">
    <div style="font-size:11px;color:var(--text-dim);margin-bottom:8px">Also in your recent history</div>
    ${items
      .map(
        (/** @type {any} */ h) => `
      <a class="search-tab-item" href="${safeHref(h.url)}" target="_blank" title="${escapeAttr(h.title ?? h.url)}">
        ${favIconHtml(h.url, state.favicons, { size: 14 })}
        <div class="search-tab-info">
          <div class="search-tab-title">${escapeHtml(h.title ?? h.url)}</div>
          <div class="search-tab-meta"><span class="search-tab-url">${escapeHtml(truncateUrl(h.url))}</span></div>
        </div>
      </a>`
      )
      .join('')}
  </div>`;
}

/**
 * Href seguro: solo http/https navegan como links (defensa en profundidad C8).
 * @param {string} url
 */
function safeHref(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') return escapeAttr(url);
    return '#';
  } catch {
    return '#';
  }
}
