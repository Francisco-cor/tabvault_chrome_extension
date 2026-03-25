// popup.js — TabVault popup controller
import { StorageManager } from '../shared/storage.js';
import {
  searchSessions, formatRelativeTime, formatDate,
  truncateUrl, groupColorHex, downloadText,
  readFileAsText, sanitizeName, GROUP_COLORS
} from '../shared/utils.js';

// ─── State ───────────────────────────────────────────────────────────────────
const S = {
  view: 'sessions',
  sessions: {},
  trash: {},
  liveGroups: [],
  liveUngrouped: [],      // fix #1: ungrouped live tabs
  detailSessionId: null,  // feat #4: detail/notes view
  searchQuery: '',
  sortBy: 'newest',       // sessions sort: newest | oldest | az | za | tabs
  theme: 'dark',          // ui theme: dark | light
  loading: true,
  expanded: new Set(),
  toastTimer: null,
  _liveListeners: null    // refs for live-groups real-time cleanup (#7)
};

// ─── Theme ───────────────────────────────────────────────────────────────────
function applyTheme(theme) {
  document.documentElement.classList.toggle('light', theme === 'light');
  const dark = document.getElementById('theme-icon-dark');
  const light = document.getElementById('theme-icon-light');
  if (dark)  dark.style.display  = theme === 'light' ? 'block' : 'none';
  if (light) light.style.display = theme === 'light' ? 'none'  : 'block';
}

// ─── Init ────────────────────────────────────────────────────────────────────
async function init() {
  // #13: detect side panel context (popup height is capped at ~560px by Chrome)
  if (window.innerHeight > 600) {
    document.documentElement.classList.add('panel-mode');
  }

  renderLoading();
  try {
    const [sessions, liveGroups, trash, settings] = await Promise.all([
      StorageManager.getSessions(),
      captureLiveGroups(),
      StorageManager.getTrash(),
      StorageManager.getSettings()
    ]);
    S.sessions = sessions;
    S.liveGroups = liveGroups;
    S.trash = trash;
    S.theme = settings.theme ?? 'dark';
    S.sortBy = settings.sortBy ?? 'newest';
    applyTheme(S.theme);
    StorageManager.purgeOldTrash();
  } catch (e) {
    console.error('[TabVault]', e);
  }
  S.loading = false;
  render();
  bindStaticEvents();
}

async function captureLiveGroups() {
  const win = await chrome.windows.getCurrent();
  const [groups, tabs] = await Promise.all([
    chrome.tabGroups.query({ windowId: win.id }),
    chrome.tabs.query({ currentWindow: true })
  ]);

  const map = new Map();
  for (const g of groups) {
    map.set(g.id, { id: g.id, name: g.title || 'Untitled', color: g.color, tabs: [] });
  }
  const ungrouped = [];
  for (const t of tabs) {
    const tab = { id: t.id, url: t.url || '', title: t.title || t.url || '…', favicon: t.favIconUrl || '' };
    if (t.groupId > 0 && map.has(t.groupId)) {
      map.get(t.groupId).tabs.push(tab);
    } else if (!t.url?.startsWith('chrome://') && !t.url?.startsWith('chrome-extension://')) {
      ungrouped.push(tab); // fix #1
    }
  }
  S.liveUngrouped = ungrouped; // fix #1
  return [...map.values()];
}

// ─── Top-level render ────────────────────────────────────────────────────────
function render() {
  const el = document.getElementById('content');
  const sessionArr = Object.values(S.sessions);

  const badge = document.getElementById('sessions-count');
  badge.textContent = sessionArr.length > 0 ? sessionArr.length : '';

  const trashBadge = document.getElementById('trash-count');
  if (trashBadge) {
    const trashCount = Object.keys(S.trash).length;
    trashBadge.textContent = trashCount > 0 ? trashCount : '';
  }

  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === S.view);
  });

  if (S.view === 'sessions') el.innerHTML = renderSessionsView(sessionArr);
  else if (S.view === 'groups') el.innerHTML = renderGroupsView();
  else if (S.view === 'detail') el.innerHTML = renderDetailView();
  else if (S.view === 'trash') el.innerHTML = renderTrashView();
  else el.innerHTML = renderSearchView();

  bindViewEvents();
}

function renderLoading() {
  document.getElementById('content').innerHTML = `
    <div class="loading-state">
      <div class="spinner"></div>
      <span class="text-dim">Loading…</span>
    </div>`;
}

// ─── Sessions View ────────────────────────────────────────────────────────────
function sortSessions(sessions) {
  const arr = [...sessions];
  switch (S.sortBy) {
    case 'oldest':  return arr.sort((a, b) => a.updated - b.updated);
    case 'az':      return arr.sort((a, b) => a.name.localeCompare(b.name));
    case 'za':      return arr.sort((a, b) => b.name.localeCompare(a.name));
    case 'tabs':    return arr.sort((a, b) => (b.metadata?.tabCount ?? 0) - (a.metadata?.tabCount ?? 0));
    default:        return arr.sort((a, b) => b.updated - a.updated); // newest
  }
}

function renderSessionsView(sessions) {
  const sorted = sortSessions(sessions);

  const cards = sorted.length === 0 ? `
    <div class="empty-state">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
        <rect x="2" y="3" width="20" height="18" rx="3"/>
        <circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/>
      </svg>
      <h4>No sessions yet</h4>
      <p>Save your current tabs as a session to get started.</p>
    </div>` : sorted.map(renderSessionCard).join('');

  return `
    <div class="save-cta" id="save-cta">
      <div class="save-cta-text">
        <strong>Save current session</strong>
        <span>${S.liveGroups.length} group${S.liveGroups.length !== 1 ? 's' : ''} · ${countCurrentTabs()} tabs open</span>
      </div>
      <button class="btn-primary" id="btn-save">Save</button>
    </div>
    ${sorted.length > 1 ? `
    <div class="sort-bar">
      <span class="sort-label">Sort</span>
      <select class="sort-select" id="sort-select">
        <option value="newest" ${S.sortBy === 'newest' ? 'selected' : ''}>Newest</option>
        <option value="oldest" ${S.sortBy === 'oldest' ? 'selected' : ''}>Oldest</option>
        <option value="az"     ${S.sortBy === 'az'     ? 'selected' : ''}>A → Z</option>
        <option value="za"     ${S.sortBy === 'za'     ? 'selected' : ''}>Z → A</option>
        <option value="tabs"   ${S.sortBy === 'tabs'   ? 'selected' : ''}>Most tabs</option>
      </select>
    </div>` : ''}
    ${cards}`;
}

function countCurrentTabs() {
  // fix #1: include ungrouped live tabs
  return S.liveGroups.reduce((n, g) => n + g.tabs.length, 0) + S.liveUngrouped.length;
}

function renderSessionCard(session) {
  const groupCount = session.groups?.length ?? 0;
  const tabCount = session.metadata?.tabCount ?? 0;
  const relTime = formatRelativeTime(session.updated);
  const fullDate = formatDate(session.updated);

  const pills = (session.groups ?? []).slice(0, 5).map(g => `
    <span class="group-pill">
      <span class="group-pill-dot" style="background:${groupColorHex(g.color)}"></span>
      ${esc(g.name || 'Untitled')}
    </span>`).join('');
  const more = (session.groups?.length ?? 0) > 5
    ? `<span class="group-pill text-muted">+${session.groups.length - 5}</span>` : '';

  const autoBadge = session.autoSaved
    ? `<span class="auto-badge">auto</span>`
    : '';

  return `
    <div class="session-card" data-id="${session.id}">
      <div class="session-card-header">
        <div class="session-card-info">
          <div class="session-name-row">
            <div class="session-name no-select" data-action="rename" data-id="${session.id}" title="Click to rename">${esc(session.name)}</div>
            ${autoBadge}
          </div>
          <div class="session-meta">
            <span class="meta-chip">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
              ${groupCount} group${groupCount !== 1 ? 's' : ''}
            </span>
            <span class="meta-dot"></span>
            <span class="meta-chip">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M4 6h16M4 10h16M4 14h8"/></svg>
              ${tabCount} tab${tabCount !== 1 ? 's' : ''}
            </span>
            <span class="meta-dot"></span>
            <span class="meta-chip" title="${fullDate}">${relTime}</span>
          </div>
        </div>
        <div class="session-card-actions">
          <div class="restore-split">
            <button class="btn-ghost" data-action="restore" data-id="${session.id}" title="Restore in new window">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M5 3l14 9-14 9V3z"/></svg>
              Restore
            </button>
            <button class="btn-ghost restore-arrow" data-action="restore-menu" data-id="${session.id}" title="Restore options">
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6,9 12,15 18,9"/></svg>
            </button>
          </div>
          <button class="btn-ghost" data-action="detail" data-id="${session.id}" title="Notes &amp; tags">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
          </button>
          <button class="btn-ghost" data-action="export-menu" data-id="${session.id}" title="Export">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="17,8 12,3 7,8"/><line x1="12" y1="3" x2="12" y2="15"/><path d="M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2"/></svg>
          </button>
          <button class="btn-ghost btn-danger" data-action="delete" data-id="${session.id}" title="Delete">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3,6 5,6 21,6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
          </button>
        </div>
      </div>
      ${pills || more ? `<div class="session-groups-preview">${pills}${more}</div>` : ''}
    </div>`;
}

// ─── Groups View ──────────────────────────────────────────────────────────────
function renderGroupsView() {
  // fix #5: include ungrouped live tabs in empty check
  if (S.liveGroups.length === 0 && S.liveUngrouped.length === 0) return `
    <div class="empty-state">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
        <path d="M4 6h16M4 12h16M4 18h7"/>
      </svg>
      <h4>No tab groups</h4>
      <p>Create tab groups in Chrome by right-clicking a tab and selecting "Add to group".</p>
    </div>`;

  // fix #5: render ungrouped live tabs section
  const ungroupedSection = S.liveUngrouped.length > 0 ? `
    <div class="live-group-card ${S.expanded.has('live-ungrouped') ? 'expanded' : ''}" data-group-id="ungrouped" style="border-left-color:var(--text-muted)">
      <div class="live-group-header" data-action="toggle-live-group" data-group-id="ungrouped">
        <div class="live-group-title">
          <span class="color-dot" style="background:var(--text-muted)"></span>
          <span class="live-group-name">Ungrouped</span>
          <span class="live-group-count">${S.liveUngrouped.length} tab${S.liveUngrouped.length !== 1 ? 's' : ''}</span>
        </div>
        <svg class="live-group-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9,18 15,12 9,6"/></svg>
      </div>
      <div class="live-group-tabs">${S.liveUngrouped.map(t => `
        <div class="live-tab-item">
          ${t.favicon
            ? `<img class="tab-favicon" src="${esc(t.favicon)}" alt="" onerror="this.style.display='none'">`
            : `<div class="tab-favicon-fallback"><svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10"/></svg></div>`}
          <div class="live-tab-info">
            <div class="live-tab-title" title="${esc(t.title)}">${esc(t.title)}</div>
            <div class="live-tab-url" title="${esc(t.url)}">${esc(truncateUrl(t.url))}</div>
          </div>
        </div>`).join('')}
      </div>
    </div>` : '';

  return S.liveGroups.map(g => renderLiveGroupCard(g)).join('') + ungroupedSection;
}

function renderLiveGroupCard(g) {
  const colorHex = groupColorHex(g.color);
  const expanded = S.expanded.has(`live-${g.id}`);

  const tabs = g.tabs.map(t => `
    <div class="live-tab-item">
      ${t.favicon
        ? `<img class="tab-favicon" src="${esc(t.favicon)}" alt="" onerror="this.style.display='none'">`
        : `<div class="tab-favicon-fallback"><svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10"/></svg></div>`}
      <div class="live-tab-info">
        <div class="live-tab-title" title="${esc(t.title)}">${esc(t.title)}</div>
        <div class="live-tab-url" title="${esc(t.url)}">${esc(truncateUrl(t.url))}</div>
      </div>
    </div>`).join('');

  return `
    <div class="live-group-card ${expanded ? 'expanded' : ''}" data-group-id="${g.id}" style="border-left-color:${colorHex}">
      <div class="live-group-header" data-action="toggle-live-group" data-group-id="${g.id}">
        <div class="live-group-title">
          <span class="color-dot" style="background:${colorHex}"></span>
          <span class="live-group-name">${esc(g.name)}</span>
          <span class="live-group-count">${g.tabs.length} tab${g.tabs.length !== 1 ? 's' : ''}</span>
        </div>
        <svg class="live-group-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9,18 15,12 9,6"/></svg>
      </div>
      <div class="live-group-tabs">${tabs}</div>
    </div>`;
}

// ─── Detail View (feat #4: notes & tags) ─────────────────────────────────────
function renderDetailView() {
  const session = S.sessions[S.detailSessionId];
  if (!session) { S.view = 'sessions'; return renderSessionsView(Object.values(S.sessions)); }

  const groups = (session.groups ?? []).map(g => renderDetailGroup(g, session.id)).join('');
  const ungrouped = session.ungroupedTabs ?? [];
  const ungroupedSection = ungrouped.length > 0 ? `
    <div class="detail-group">
      <div class="detail-group-header">
        <span class="detail-group-name">Ungrouped</span>
        <span class="live-group-count">${ungrouped.length} tab${ungrouped.length !== 1 ? 's' : ''}</span>
      </div>
      ${ungrouped.map(tab => renderDetailTab(tab, null, session.id)).join('')}
    </div>` : '';

  const body = groups + ungroupedSection || `<p class="text-muted" style="text-align:center;margin-top:24px;font-size:12px">No groups in this session.</p>`;

  return `
    <div class="detail-back" data-action="back">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15,18 9,12 15,6"/></svg>
      <span>${esc(session.name)}</span>
    </div>
    <button class="btn-secondary detail-add-tab" data-action="add-current-tab" data-session-id="${session.id}">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      Add current tab
    </button>
    ${body}`;
}

function renderDetailGroup(group, sessionId) {
  const colorHex = groupColorHex(group.color);
  const tags = (group.tags ?? []).map((tag, i) => `
    <span class="tag-chip">
      ${esc(tag)}
      <button class="tag-remove" data-action="remove-group-tag"
        data-session-id="${sessionId}" data-group-id="${group.id}" data-tag-index="${i}">×</button>
    </span>`).join('');

  return `
    <div class="detail-group">
      <div class="detail-group-header" style="border-left:2px solid ${colorHex}">
        <span class="color-dot" style="background:${colorHex}"></span>
        <span class="detail-group-name">${esc(group.name)}</span>
        <span class="live-group-count">${group.tabs?.length ?? 0} tab${(group.tabs?.length ?? 0) !== 1 ? 's' : ''}</span>
        <button class="btn-ghost btn-danger detail-remove-group" data-action="remove-group"
          data-session-id="${sessionId}" data-group-id="${group.id}" title="Remove group">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3,6 5,6 21,6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
        </button>
      </div>
      <div class="tags-row">
        ${tags}
        <button class="tag-add-btn" data-action="add-group-tag"
          data-session-id="${sessionId}" data-group-id="${group.id}">+ tag</button>
      </div>
      <textarea class="note-area" placeholder="Group note…"
        data-action="note-group" data-session-id="${sessionId}" data-group-id="${group.id}"
        rows="2">${esc(group.note ?? '')}</textarea>
      ${(group.tabs ?? []).map(tab => renderDetailTab(tab, group.id, sessionId)).join('')}
    </div>`;
}

function renderDetailTab(tab, groupId, sessionId) {
  return `
    <div class="detail-tab">
      ${tab.favicon
        ? `<img class="tab-favicon" src="${esc(tab.favicon)}" alt="" onerror="this.style.display='none'">`
        : `<div class="tab-favicon-fallback"></div>`}
      <div class="detail-tab-content">
        <div class="live-tab-title" title="${esc(tab.title)}">${esc(tab.title || tab.url)}</div>
        <textarea class="note-area" style="min-height:26px;margin:3px 0 0;font-size:10.5px"
          placeholder="Tab note…"
          data-action="note-tab" data-session-id="${sessionId}"
          data-group-id="${groupId ?? ''}" data-tab-id="${tab.id}"
          rows="1">${esc(tab.note ?? '')}</textarea>
      </div>
      <button class="btn-ghost btn-danger detail-tab-remove" data-action="remove-tab"
        data-session-id="${sessionId}" data-group-id="${groupId ?? ''}" data-tab-id="${tab.id}"
        title="Remove tab">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>`;
}

// ─── Search View ──────────────────────────────────────────────────────────────
function renderSearchView() {
  const results = searchSessions(S.sessions, S.searchQuery);
  const resultsHtml = S.searchQuery.trim()
    ? renderSearchResults(results)
    : renderRecentTabs();

  return `
    <div class="search-bar">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <input id="search-input" class="search-input" type="search"
        placeholder="Search tabs, sessions, tags…"
        value="${esc(S.searchQuery)}" autocomplete="off" spellcheck="false">
    </div>
    ${resultsHtml}`;
}

function renderSearchResults(results) {
  if (results.length === 0) return `
    <div class="empty-state">
      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <h4>No results</h4>
      <p>Try different keywords.</p>
    </div>`;

  return results.map(session => {
    const matchingTabs = session._matchingTabs ?? [];
    if (matchingTabs.length === 0) {
      return `
        <div class="search-result-group">
          <div class="search-result-session">${esc(session.name)}</div>
          ${renderAllTabsForSession(session)}
        </div>`;
    }
    return `
      <div class="search-result-group">
        <div class="search-result-session">${esc(session.name)}</div>
        ${matchingTabs.sort((a, b) => b._score - a._score).slice(0, 8).map(tab => `
          <a class="search-tab-item" href="${esc(tab.url)}" target="_blank" title="${esc(tab.title)}\n${esc(tab.url)}">
            ${tab.favicon
              ? `<img class="tab-favicon" src="${esc(tab.favicon)}" alt="" onerror="this.style.display='none'" width="14" height="14">`
              : `<div class="tab-favicon-fallback" style="width:14px;height:14px"></div>`}
            <div class="search-tab-info">
              <div class="search-tab-title">${esc(tab.title || tab.url)}</div>
              <div class="search-tab-meta">
                <span class="search-tab-url">${esc(truncateUrl(tab.url))}</span>
                <span class="meta-dot"></span>
                <span>${esc(tab._groupName ?? '')}</span>
              </div>
            </div>
          </a>`).join('')}
      </div>`;
  }).join('');
}

function renderAllTabsForSession(session) {
  const allTabs = [
    ...(session.ungroupedTabs ?? []),
    ...(session.groups ?? []).flatMap(g => g.tabs ?? [])
  ].slice(0, 6);

  return allTabs.map(tab => {
    try {
      return `
        <a class="search-tab-item" href="${esc(tab.url)}" target="_blank">
          ${tab.favicon
            ? `<img class="tab-favicon" src="${esc(tab.favicon)}" alt="" onerror="this.style.display='none'" width="14" height="14">`
            : `<div class="tab-favicon-fallback" style="width:14px;height:14px"></div>`}
          <div class="search-tab-info">
            <div class="search-tab-title">${esc(tab.title || tab.url)}</div>
            <div class="search-tab-meta"><span class="search-tab-url">${esc(truncateUrl(tab.url))}</span></div>
          </div>
        </a>`;
    } catch { return ''; }
  }).join('');
}

// ─── Trash View (#6) ──────────────────────────────────────────────────────────
function renderTrashView() {
  const items = Object.values(S.trash).sort((a, b) => b.deletedAt - a.deletedAt);
  if (items.length === 0) return `
    <div class="empty-state">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
        <polyline points="3,6 5,6 21,6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
        <path d="M10 11v6M14 11v6"/>
      </svg>
      <h4>Trash is empty</h4>
      <p>Deleted sessions are kept here for 30 days.</p>
    </div>`;

  return items.map(session => {
    const tabCount = session.metadata?.tabCount ?? 0;
    return `
      <div class="session-card trash-card" data-id="${session.id}">
        <div class="session-card-header">
          <div class="session-card-info">
            <div class="session-name-row">
              <div class="session-name">${esc(session.name)}</div>
            </div>
            <div class="session-meta">
              <span class="meta-chip">${tabCount} tab${tabCount !== 1 ? 's' : ''}</span>
              <span class="meta-dot"></span>
              <span class="meta-chip">Deleted ${formatRelativeTime(session.deletedAt)}</span>
            </div>
          </div>
          <div class="session-card-actions" style="opacity:1">
            <button class="btn-ghost" data-action="restore-trash" data-id="${session.id}" title="Restore session">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
              Restore
            </button>
            <button class="btn-ghost btn-danger" data-action="delete-permanent" data-id="${session.id}" title="Delete forever">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3,6 5,6 21,6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
            </button>
          </div>
        </div>
      </div>`;
  }).join('');
}

function renderRecentTabs() {
  const sessions = Object.values(S.sessions).sort((a, b) => b.updated - a.updated).slice(0, 3);
  if (sessions.length === 0) return `<p class="text-dim" style="text-align:center;margin-top:32px;font-size:12px">No saved sessions to search.</p>`;

  return `<div style="font-size:11px;color:var(--text-dim);margin-bottom:8px">Recent sessions</div>` +
    sessions.map(session => `
      <div class="search-result-group">
        <div class="search-result-session">${esc(session.name)} <span style="font-weight:400;text-transform:none;letter-spacing:0">${formatRelativeTime(session.updated)}</span></div>
        ${renderAllTabsForSession(session)}
      </div>`).join('');
}

// ─── Live Groups real-time listeners (#7) ─────────────────────────────────────
function startLiveListeners() {
  if (S._liveListeners) return;
  let debounceTimer = null;

  const refresh = async () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      if (S.view !== 'groups') return;
      S.liveGroups = await captureLiveGroups();
      if (S.view === 'groups') render();
    }, 120);
  };

  const onTabCreated   = ()               => refresh();
  const onTabRemoved   = ()               => refresh();
  const onTabUpdated   = (id, change)     => {
    if (change.title !== undefined || change.url !== undefined || change.groupId !== undefined) refresh();
  };
  const onGroupCreated = ()               => refresh();
  const onGroupRemoved = ()               => refresh();
  const onGroupUpdated = ()               => refresh();

  chrome.tabs.onCreated.addListener(onTabCreated);
  chrome.tabs.onRemoved.addListener(onTabRemoved);
  chrome.tabs.onUpdated.addListener(onTabUpdated);
  chrome.tabGroups.onCreated.addListener(onGroupCreated);
  chrome.tabGroups.onRemoved.addListener(onGroupRemoved);
  chrome.tabGroups.onUpdated.addListener(onGroupUpdated);

  S._liveListeners = { onTabCreated, onTabRemoved, onTabUpdated, onGroupCreated, onGroupRemoved, onGroupUpdated };
}

function stopLiveListeners() {
  if (!S._liveListeners) return;
  const { onTabCreated, onTabRemoved, onTabUpdated, onGroupCreated, onGroupRemoved, onGroupUpdated } = S._liveListeners;
  chrome.tabs.onCreated.removeListener(onTabCreated);
  chrome.tabs.onRemoved.removeListener(onTabRemoved);
  chrome.tabs.onUpdated.removeListener(onTabUpdated);
  chrome.tabGroups.onCreated.removeListener(onGroupCreated);
  chrome.tabGroups.onRemoved.removeListener(onGroupRemoved);
  chrome.tabGroups.onUpdated.removeListener(onGroupUpdated);
  S._liveListeners = null;
}

// ─── Event Binding ───────────────────────────────────────────────────────────
function bindStaticEvents() {
  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const prev = S.view;
      S.view = btn.dataset.view;
      if (prev === 'groups' && S.view !== 'groups') stopLiveListeners();
      if (S.view === 'groups') startLiveListeners();
      render();
      if (S.view === 'search') {
        requestAnimationFrame(() => document.getElementById('search-input')?.focus());
      }
    });
  });

  document.getElementById('btn-theme').addEventListener('click', async () => {
    S.theme = S.theme === 'dark' ? 'light' : 'dark';
    applyTheme(S.theme);
    await StorageManager.saveSettings({ theme: S.theme, sortBy: S.sortBy });
  });

  document.getElementById('btn-export-all').addEventListener('click', async () => {
    const json = await StorageManager.exportAll();
    downloadText(json, 'tabvault-backup.json');
    toast('Backup exported', 'success');
  });

  // #13: open as side panel (Chrome 116+); button hidden in panel-mode via CSS
  document.getElementById('btn-side-panel').addEventListener('click', async () => {
    try {
      const win = await chrome.windows.getCurrent();
      await chrome.sidePanel.open({ windowId: win.id });
      window.close();
    } catch {
      toast('Side panel requires Chrome 116+', 'error');
    }
  });

  // Import: show menu to choose merge vs overwrite
  document.getElementById('btn-import').addEventListener('click', () => {
    const existing = document.getElementById('import-menu-popup');
    if (existing) { existing.remove(); return; }

    const btn = document.getElementById('btn-import');
    const hasExisting = Object.keys(S.sessions).length > 0;

    const menu = document.createElement('div');
    menu.id = 'import-menu-popup';
    menu.style.cssText = `position:fixed;background:var(--surface-2);border:1px solid var(--border-hover);border-radius:var(--radius);padding:4px;z-index:50;box-shadow:0 8px 24px rgba(0,0,0,0.4);min-width:154px`;
    menu.innerHTML = `
      <button class="btn-ghost" style="display:block;width:100%;text-align:left" id="imp-merge">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="margin-right:4px"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>
        Merge with existing
      </button>
      ${hasExisting ? `<button class="btn-ghost btn-danger" style="display:block;width:100%;text-align:left" id="imp-replace">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="margin-right:4px"><polyline points="1,4 1,10 7,10"/><path d="M3.51 15a9 9 0 1 0 .49-4.95"/></svg>
        Replace all
      </button>` : ''}`;

    const rect = btn.getBoundingClientRect();
    menu.style.top  = (rect.bottom + 4) + 'px';
    menu.style.right = (window.innerWidth - rect.right) + 'px';
    document.body.appendChild(menu);

    menu.querySelector('#imp-merge')?.addEventListener('click', () => {
      menu.remove();
      document.getElementById('import-file').dataset.mode = 'merge';
      document.getElementById('import-file').click();
    });
    menu.querySelector('#imp-replace')?.addEventListener('click', () => {
      menu.remove();
      document.getElementById('import-file').dataset.mode = 'replace';
      document.getElementById('import-file').click();
    });

    setTimeout(() => {
      document.addEventListener('click', () => menu.remove(), { once: true });
    }, 0);
  });

  document.getElementById('import-file').addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    const mode = e.target.dataset.mode ?? 'replace';
    try {
      const text = await readFileAsText(file);
      const data = JSON.parse(text);
      if (!data._tabvault) throw new Error('Not a valid TabVault export file');

      if (mode === 'merge') {
        // Merge: add imported sessions without deleting existing ones
        const imported = data.sessions ?? {};
        const existing = await StorageManager.getSessions();
        const merged = { ...existing, ...imported }; // imported wins on collision
        await chrome.storage.local.set({ sessions: merged });
        StorageManager.invalidate();
        S.sessions = await StorageManager.getSessions();
        toast(`Merged ${Object.keys(imported).length} sessions`, 'success');
      } else {
        await StorageManager.importAll(text);
        S.sessions = await StorageManager.getSessions();
        toast(`Imported ${Object.keys(S.sessions).length} sessions`, 'success');
      }
      render();
    } catch (err) {
      toast(`Import failed: ${err.message}`, 'error');
    }
    e.target.value = '';
    delete e.target.dataset.mode;
  });

  document.getElementById('modal-confirm').addEventListener('click', () => confirmSave());
  document.getElementById('modal-cancel').addEventListener('click', () => closeSaveModal());
  document.getElementById('session-name-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') confirmSave();
    if (e.key === 'Escape') closeSaveModal();
  });
  document.getElementById('save-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeSaveModal();
  });

  // feat #7: delete confirmation modal
  document.getElementById('delete-confirm').addEventListener('click', () => confirmDelete());
  document.getElementById('delete-cancel').addEventListener('click', () => closeDeleteModal());
  document.getElementById('delete-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeDeleteModal();
  });
}

function bindViewEvents() {
  const content = document.getElementById('content');

  document.getElementById('btn-save')?.addEventListener('click', openSaveModal);
  document.getElementById('save-cta')?.addEventListener('click', e => {
    if (!e.target.closest('button')) openSaveModal();
  });

  document.getElementById('sort-select')?.addEventListener('change', async e => {
    S.sortBy = e.target.value;
    await StorageManager.saveSettings({ theme: S.theme, sortBy: S.sortBy });
    render();
  });

  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    searchInput.addEventListener('input', e => {
      S.searchQuery = e.target.value;
      const res = searchSessions(S.sessions, S.searchQuery);
      const rContainer = content.querySelector('.search-bar');
      const after = rContainer.nextSibling;
      if (after) after.remove();
      const div = document.createElement('div');
      div.innerHTML = S.searchQuery.trim() ? renderSearchResults(res) : renderRecentTabs();
      [...div.childNodes].forEach(n => content.appendChild(n));
    });
    searchInput.addEventListener('focus', e => e.target.select());
  }

  // feat #4: wire note autosave on blur for detail view
  if (S.view === 'detail') {
    content.querySelectorAll('textarea[data-action="note-group"]').forEach(el => {
      el.addEventListener('blur', () => saveNoteGroup(el.dataset.sessionId, el.dataset.groupId, el.value));
    });
    content.querySelectorAll('textarea[data-action="note-tab"]').forEach(el => {
      el.addEventListener('blur', () => saveNoteTab(el.dataset.sessionId, el.dataset.groupId || null, el.dataset.tabId, el.value));
    });
  }

  content.addEventListener('click', handleContentClick);
  content.addEventListener('dblclick', handleDoubleClick);
}

async function handleContentClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;

  const action = btn.dataset.action;
  const id = btn.dataset.id;

  switch (action) {
    case 'restore':           await restoreSession(id); break;
    case 'restore-menu':      await showRestoreMenu(id); break;
    case 'delete':            await deleteSession(id); break;
    case 'export-menu':       await exportSession(id); break;
    case 'toggle-live-group': toggleLiveGroup(btn.dataset.groupId); break;
    case 'rename':            startRename(btn, id); break;
    case 'detail':            openDetailView(id); break;
    case 'back':              S.view = 'sessions'; render(); break;
    case 'remove-group-tag':  await removeGroupTag(btn.dataset.sessionId, btn.dataset.groupId, +btn.dataset.tagIndex); break;
    case 'add-group-tag':     startAddGroupTag(btn); break;
    // #5: session editing
    case 'remove-tab':        await removeTab(btn.dataset.sessionId, btn.dataset.groupId || null, btn.dataset.tabId); break;
    case 'remove-group':      await removeGroup(btn.dataset.sessionId, btn.dataset.groupId); break;
    case 'add-current-tab':   await addCurrentTab(btn.dataset.sessionId); break;
    // #6: trash
    case 'restore-trash':     await restoreFromTrash(btn.dataset.id); break;
    case 'delete-permanent':  await deletePermanent(btn.dataset.id); break;
  }
}

function handleDoubleClick(e) {
  const nameEl = e.target.closest('.session-name');
  if (nameEl) startRename(nameEl, nameEl.dataset.id);
}

// ─── Actions ──────────────────────────────────────────────────────────────────
function openSaveModal() {
  const modal = document.getElementById('save-modal');
  const input = document.getElementById('session-name-input');
  const now = new Date();
  // use undefined locale so it respects the user's system language
  input.value = `${now.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} session`;
  modal.removeAttribute('hidden');
  requestAnimationFrame(() => { input.focus(); input.select(); });
}

function closeSaveModal() {
  // reset duplicate acknowledgement when modal is dismissed
  delete document.getElementById('modal-confirm')._duplicateAcknowledged;
  document.getElementById('duplicate-warning').setAttribute('hidden', '');
  document.getElementById('save-modal').setAttribute('hidden', '');
}

async function confirmSave() {
  const name = document.getElementById('session-name-input').value.trim() || 'Untitled Session';
  const confirmBtn = document.getElementById('modal-confirm');
  const warningEl = document.getElementById('duplicate-warning');

  // feat #8: duplicate detection — require a second click to confirm
  if (!confirmBtn._duplicateAcknowledged) {
    const duplicate = findDuplicateSession();
    if (duplicate) {
      confirmBtn._duplicateAcknowledged = true;
      warningEl.textContent = `Similar to "${duplicate.name}". Click Save again to confirm.`;
      warningEl.removeAttribute('hidden');
      return;
    }
  }

  closeSaveModal();

  const btn = document.getElementById('btn-save');
  if (btn) { btn.textContent = 'Saving…'; btn.disabled = true; }

  try {
    const result = await chrome.runtime.sendMessage({ type: 'CAPTURE_SESSION', name });
    if (result?.ok) {
      // #11: service worker wrote to storage in a different context — invalidate cache
      StorageManager.invalidate();
      S.sessions = await StorageManager.getSessions();
      render();
      toast(`"${name}" saved`, 'success');
      // #12: warn if storage is approaching the 10 MB limit
      StorageManager.getUsagePercent().then(pct => {
        if (pct >= 80) {
          setTimeout(() => toast(`Storage ${pct}% full — export a backup soon`, 'error'), 2600);
        }
      });
    } else {
      toast(result?.error ?? 'Save failed', 'error');
    }
  } catch (e) {
    toast('Could not save session', 'error');
  }
}

// feat #8: Jaccard similarity against all saved sessions
function findDuplicateSession() {
  const currentUrls = new Set([
    ...S.liveGroups.flatMap(g => g.tabs.map(t => t.url)),
    ...S.liveUngrouped.map(t => t.url)
  ].filter(u => u && !u.startsWith('chrome://')));

  if (currentUrls.size === 0) return null;

  let best = null;
  let bestScore = 0;

  for (const session of Object.values(S.sessions)) {
    const sessionUrls = new Set([
      ...(session.groups ?? []).flatMap(g => (g.tabs ?? []).map(t => t.url)),
      ...(session.ungroupedTabs ?? []).map(t => t.url)
    ].filter(Boolean));

    if (sessionUrls.size === 0) continue;

    const intersection = [...currentUrls].filter(u => sessionUrls.has(u)).length;
    const union = new Set([...currentUrls, ...sessionUrls]).size;
    const score = intersection / union;
    if (score > bestScore) { bestScore = score; best = session; }
  }

  return bestScore >= 0.8 ? best : null;
}

async function restoreSession(id) {
  const session = S.sessions[id];
  if (!session) return;

  const tabCount = session.metadata?.tabCount ?? 0;
  toast(`Restoring "${session.name}"…`);

  try {
    const result = await chrome.runtime.sendMessage({ type: 'RESTORE_SESSION', sessionId: id });
    if (result?.ok) toast(`Opened ${tabCount} tabs`, 'success');
    else toast(result?.error ?? 'Restore failed', 'error');
  } catch (e) {
    toast('Could not restore session', 'error');
  }
}

// feat #6: restore into the current window instead of a new one
async function restoreSessionInWindow(id, windowId) {
  const session = S.sessions[id];
  if (!session) return;

  toast(`Restoring "${session.name}" here…`);
  try {
    const result = await chrome.runtime.sendMessage({ type: 'RESTORE_SESSION', sessionId: id, windowId });
    if (result?.ok) toast('Tabs added to this window', 'success');
    else toast(result?.error ?? 'Restore failed', 'error');
  } catch (e) {
    toast('Could not restore session', 'error');
  }
}

// feat #6: dropdown to choose new window vs this window
async function showRestoreMenu(id) {
  const btn = document.querySelector(`[data-action="restore-menu"][data-id="${id}"]`);
  if (!btn) return;

  const existing = document.getElementById('restore-menu-popup');
  if (existing) { existing.remove(); return; }

  const menu = document.createElement('div');
  menu.id = 'restore-menu-popup';
  menu.style.cssText = `position:fixed;background:var(--surface-2);border:1px solid var(--border-hover);border-radius:var(--radius);padding:4px;z-index:50;box-shadow:0 8px 24px rgba(0,0,0,0.4);min-width:140px`;
  menu.innerHTML = `
    <button class="btn-ghost" style="display:block;width:100%;text-align:left" id="rst-new-win">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="margin-right:4px"><rect x="2" y="3" width="20" height="18" rx="2"/><path d="M2 9h20"/></svg>
      New window
    </button>
    <button class="btn-ghost" style="display:block;width:100%;text-align:left" id="rst-this-win">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="margin-right:4px"><path d="M5 3l14 9-14 9V3z"/></svg>
      This window
    </button>`;

  const rect = btn.getBoundingClientRect();
  menu.style.top = (rect.bottom + 4) + 'px';
  menu.style.right = (window.innerWidth - rect.right) + 'px';
  document.body.appendChild(menu);

  menu.querySelector('#rst-new-win').addEventListener('click', async () => {
    menu.remove();
    await restoreSession(id);
  });
  menu.querySelector('#rst-this-win').addEventListener('click', async () => {
    menu.remove();
    const win = await chrome.windows.getCurrent();
    await restoreSessionInWindow(id, win.id);
  });

  setTimeout(() => {
    document.addEventListener('click', () => menu.remove(), { once: true });
  }, 0);
}

// feat #7: use a modal for delete confirmation instead of button double-click
let _pendingDeleteId = null;

function openDeleteModal(id) {
  _pendingDeleteId = id;
  const session = S.sessions[id];
  document.getElementById('delete-modal-desc').textContent =
    `"${session?.name ?? 'This session'}" will be moved to Trash.`;
  document.getElementById('delete-modal').removeAttribute('hidden');
}

function closeDeleteModal() {
  _pendingDeleteId = null;
  document.getElementById('delete-modal').setAttribute('hidden', '');
}

async function deleteSession(id) {
  if (!S.sessions[id]) return;
  openDeleteModal(id);
}

async function confirmDelete() {
  const id = _pendingDeleteId;
  closeDeleteModal();
  if (!id || !S.sessions[id]) return;

  const session = S.sessions[id];
  const card = document.querySelector(`.session-card[data-id="${id}"]`);
  await StorageManager.deleteSession(id); // now soft-deletes
  S.trash[id] = { ...session, deletedAt: Date.now() };
  delete S.sessions[id];

  if (card) {
    card.style.transition = 'opacity 0.2s, transform 0.2s';
    card.style.opacity = '0'; card.style.transform = 'translateX(8px)';
    setTimeout(() => {
      card.remove();
      document.getElementById('sessions-count').textContent = Object.keys(S.sessions).length || '';
      const trashBadge = document.getElementById('trash-count');
      if (trashBadge) trashBadge.textContent = Object.keys(S.trash).length || '';
    }, 200);
  } else {
    render();
  }
  toast('Moved to Trash');
}

async function exportSession(id) {
  const session = S.sessions[id];
  if (!session) return;

  const btn = document.querySelector(`[data-action="export-menu"][data-id="${id}"]`);
  if (!btn) return;

  const existing = document.getElementById('export-menu-popup');
  if (existing) { existing.remove(); return; }

  const menu = document.createElement('div');
  menu.id = 'export-menu-popup';
  menu.style.cssText = `position:fixed;background:var(--surface-2);border:1px solid var(--border-hover);border-radius:var(--radius);padding:4px;z-index:50;box-shadow:0 8px 24px rgba(0,0,0,0.4);`;
  menu.innerHTML = `
    <button class="btn-ghost" style="display:block;width:100%;text-align:left" id="exp-json">Export JSON</button>
    <button class="btn-ghost" style="display:block;width:100%;text-align:left" id="exp-md">Export Markdown</button>`;

  const rect = btn.getBoundingClientRect();
  menu.style.top = (rect.bottom + 4) + 'px';
  menu.style.right = (window.innerWidth - rect.right) + 'px';
  document.body.appendChild(menu);

  menu.querySelector('#exp-json').addEventListener('click', async () => {
    const json = await StorageManager.exportSession(id);
    downloadText(json, `${sanitizeName(session.name)}.json`);
    menu.remove(); toast('Exported as JSON', 'success');
  });
  menu.querySelector('#exp-md').addEventListener('click', () => {
    const md = StorageManager.exportAsMarkdown(session);
    downloadText(md, `${sanitizeName(session.name)}.md`);
    menu.remove(); toast('Exported as Markdown', 'success');
  });

  setTimeout(() => {
    document.addEventListener('click', () => menu.remove(), { once: true });
  }, 0);
}

function toggleLiveGroup(groupId) {
  const key = `live-${groupId}`;
  if (S.expanded.has(key)) S.expanded.delete(key);
  else S.expanded.add(key);
  const card = document.querySelector(`.live-group-card[data-group-id="${groupId}"]`);
  if (card) card.classList.toggle('expanded', S.expanded.has(key));
}

// fix #2: use AbortController so keydown listener never accumulates
function startRename(el, id) {
  if (el.getAttribute('contenteditable') === 'true') return;

  el.setAttribute('contenteditable', 'true');
  el.classList.add('editing');
  el.focus();

  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  const controller = new AbortController();

  const finish = async (save) => {
    controller.abort();
    el.removeAttribute('contenteditable');
    el.classList.remove('editing');
    if (save) {
      const newName = el.textContent.trim() || S.sessions[id]?.name;
      if (newName !== S.sessions[id]?.name) {
        await StorageManager.updateSession(id, { name: newName });
        S.sessions[id].name = newName;
        toast('Renamed', 'success');
      }
    } else {
      el.textContent = S.sessions[id]?.name ?? '';
    }
  };

  el.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') finish(false);
  }, { signal: controller.signal });

  el.addEventListener('blur', () => finish(true), { once: true });
}

// ─── Detail view actions (feat #4) ───────────────────────────────────────────
function openDetailView(id) {
  S.detailSessionId = id;
  S.view = 'detail';
  render();
}

async function removeGroupTag(sessionId, groupId, tagIndex) {
  const session = S.sessions[sessionId];
  if (!session) return;
  const group = session.groups?.find(g => g.id === groupId);
  if (!group) return;
  group.tags = (group.tags ?? []).filter((_, i) => i !== tagIndex);
  await StorageManager.updateSession(sessionId, { groups: session.groups });
  render();
}

function startAddGroupTag(btn) {
  const sessionId = btn.dataset.sessionId;
  const groupId = btn.dataset.groupId;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'tag-input';
  input.placeholder = 'tag…';
  input.maxLength = 30;
  btn.replaceWith(input);
  input.focus();

  const commit = async () => {
    const val = input.value.trim();
    if (val) {
      const session = S.sessions[sessionId];
      if (session) {
        const group = session.groups?.find(g => g.id === groupId);
        if (group) {
          group.tags = [...(group.tags ?? []), val];
          await StorageManager.updateSession(sessionId, { groups: session.groups });
        }
      }
    }
    render();
  };

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') render();
  });
  input.addEventListener('blur', commit, { once: true });
}

async function saveNoteGroup(sessionId, groupId, note) {
  const session = S.sessions[sessionId];
  if (!session) return;
  const group = session.groups?.find(g => g.id === groupId);
  if (!group || group.note === note) return;
  group.note = note;
  await StorageManager.updateSession(sessionId, { groups: session.groups });
}

async function saveNoteTab(sessionId, groupId, tabId, note) {
  const session = S.sessions[sessionId];
  if (!session) return;
  let tab;
  if (groupId) {
    tab = session.groups?.find(g => g.id === groupId)?.tabs?.find(t => t.id === tabId);
  } else {
    tab = session.ungroupedTabs?.find(t => t.id === tabId);
  }
  if (!tab || tab.note === note) return;
  tab.note = note;
  await StorageManager.updateSession(sessionId, { groups: session.groups, ungroupedTabs: session.ungroupedTabs });
}

// ─── Session editing (#5) ────────────────────────────────────────────────────
async function removeTab(sessionId, groupId, tabId) {
  const updated = await StorageManager.removeTabFromSession(sessionId, groupId || null, tabId);
  S.sessions[sessionId] = updated;
  render();
  toast('Tab removed');
}

async function removeGroup(sessionId, groupId) {
  const updated = await StorageManager.removeGroupFromSession(sessionId, groupId);
  S.sessions[sessionId] = updated;
  render();
  toast('Group removed');
}

async function addCurrentTab(sessionId) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
    toast('Cannot add this tab', 'error');
    return;
  }
  const tabData = {
    id: StorageManager.generateId(),
    url: tab.url,
    title: tab.title || tab.url,
    favicon: tab.favIconUrl || '',
    note: '',
    tags: [],
    savedAt: Date.now()
  };
  const updated = await StorageManager.addTabToSession(sessionId, tabData);
  S.sessions[sessionId] = updated;
  render();
  toast('Tab added', 'success');
}

// ─── Trash actions (#6) ───────────────────────────────────────────────────────
async function restoreFromTrash(id) {
  const session = await StorageManager.restoreFromTrash(id);
  S.sessions[session.id] = session;
  delete S.trash[id];
  render();
  toast(`"${session.name}" restored`, 'success');
}

async function deletePermanent(id) {
  await StorageManager.deletePermanently(id);
  delete S.trash[id];
  render();
  toast('Permanently deleted');
}

// ─── Toast ───────────────────────────────────────────────────────────────────
function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast${type ? ' ' + type : ''}`;
  el.removeAttribute('hidden');
  clearTimeout(S.toastTimer);
  S.toastTimer = setTimeout(() => el.setAttribute('hidden', ''), 2500);
}

// ─── Utils ───────────────────────────────────────────────────────────────────
function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────
init();
