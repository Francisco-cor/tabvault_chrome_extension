// popup.js — TabVault popup controller (v2)
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
  liveUngrouped: [],
  detailSessionId: null,
  searchQuery: '',
  sortBy: 'newest',
  theme: 'dark',
  loading: true,
  expanded: new Set(),
  toastTimer: null,
  _liveListeners: null,
  // v2 state
  filterTags: [],          // active tag filters
  bulkMode: false,
  bulkSelected: new Set(),
  undoAction: null,        // { type, data, timer }
  kbIndex: -1,             // keyboard navigation index
  autoSaveMinutes: 0,
  syncEnabled: false,
  showVersions: false,     // toggle in detail view
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
  if (new URLSearchParams(location.search).get('panel') === 'true') {
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
    S.autoSaveMinutes = settings.autoSaveMinutes ?? 0;
    S.syncEnabled = settings.syncEnabled ?? false;
    applyTheme(S.theme);
    StorageManager.purgeOldTrash();

    // Sync: if enabled, try loading synced settings
    if (S.syncEnabled) {
      const synced = await StorageManager.loadSyncSettings();
      if (synced) {
        S.theme = synced.theme ?? S.theme;
        S.sortBy = synced.sortBy ?? S.sortBy;
        applyTheme(S.theme);
      }
    }
  } catch (e) {
    console.error('[TabVault]', e);
  }
  S.loading = false;
  render();
  bindStaticEvents();
  bindKeyboardNav();
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
      ungrouped.push(tab);
    }
  }
  S.liveUngrouped = ungrouped;
  return [...map.values()];
}

// ─── Reusable context menu ───────────────────────────────────────────────────
let _activeMenu = null;

function showMenu(anchor, items) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';

  for (const item of items) {
    if (item.divider) {
      const d = document.createElement('div');
      d.className = 'ctx-divider';
      menu.appendChild(d);
      continue;
    }
    const btn = document.createElement('button');
    btn.className = `ctx-item${item.danger ? ' danger' : ''}`;
    btn.innerHTML = (item.icon ?? '') + ' ' + item.label;
    btn.addEventListener('click', () => { closeMenu(); item.action(); });
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  menu.style.top = (rect.bottom + 4) + 'px';

  // Prefer aligning to the right edge of the anchor
  const menuWidth = menu.offsetWidth;
  const rightPos = window.innerWidth - rect.right;
  if (rect.right - menuWidth > 0) {
    menu.style.right = rightPos + 'px';
  } else {
    menu.style.left = rect.left + 'px';
  }

  _activeMenu = { el: menu, cleanup: null };
  // Close on outside click (next tick to avoid the triggering click)
  requestAnimationFrame(() => {
    const handler = (e) => {
      if (!menu.contains(e.target)) { closeMenu(); document.removeEventListener('click', handler, true); }
    };
    document.addEventListener('click', handler, true);
    _activeMenu.cleanup = () => document.removeEventListener('click', handler, true);
  });
}

function closeMenu() {
  if (_activeMenu) {
    _activeMenu.el.remove();
    _activeMenu.cleanup?.();
    _activeMenu = null;
  }
}

// ─── Top-level render ────────────────────────────────────────────────────────
function render() {
  const el = document.getElementById('content');
  const sessionArr = Object.values(S.sessions);

  document.getElementById('sessions-count').textContent = sessionArr.length > 0 ? sessionArr.length : '';
  const trashBadge = document.getElementById('trash-count');
  if (trashBadge) {
    const trashCount = Object.keys(S.trash).length;
    trashBadge.textContent = trashCount > 0 ? trashCount : '';
  }

  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === S.view);
  });

  // Bulk bar
  const bulkBar = document.getElementById('bulk-bar');
  if (S.bulkMode && S.view === 'sessions') {
    bulkBar.removeAttribute('hidden');
    document.getElementById('bulk-count').textContent = `${S.bulkSelected.size} selected`;
  } else {
    bulkBar.setAttribute('hidden', '');
  }

  if (S.view === 'sessions') el.innerHTML = renderSessionsView(sessionArr);
  else if (S.view === 'groups') el.innerHTML = renderGroupsView();
  else if (S.view === 'detail') el.innerHTML = renderDetailView();
  else if (S.view === 'trash') el.innerHTML = renderTrashView();
  else if (S.view === 'settings') el.innerHTML = renderSettingsView();
  else el.innerHTML = renderSearchView();

  bindViewEvents();
  S.kbIndex = -1;
}

function renderLoading() {
  document.getElementById('content').innerHTML = `
    <div class="loading-state">
      <div class="spinner"></div>
      <span class="text-dim">Loading…</span>
    </div>`;
}

// ─── Collect all tags ────────────────────────────────────────────────────────
function collectAllTags() {
  const tags = new Set();
  for (const session of Object.values(S.sessions)) {
    for (const g of (session.groups ?? [])) {
      for (const t of (g.tags ?? [])) tags.add(t);
    }
  }
  return [...tags].sort();
}

// ─── Sessions View ───────────────────────────────────────────────────────────
function sortSessions(sessions) {
  const arr = [...sessions];
  // Pinned always first
  arr.sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    switch (S.sortBy) {
      case 'oldest':  return a.updated - b.updated;
      case 'az':      return a.name.localeCompare(b.name);
      case 'za':      return b.name.localeCompare(a.name);
      case 'tabs':    return (b.metadata?.tabCount ?? 0) - (a.metadata?.tabCount ?? 0);
      default:        return b.updated - a.updated;
    }
  });
  return arr;
}

function filterByTags(sessions) {
  if (S.filterTags.length === 0) return sessions;
  return sessions.filter(session => {
    const sessionTags = new Set();
    for (const g of (session.groups ?? [])) {
      for (const t of (g.tags ?? [])) sessionTags.add(t);
    }
    return S.filterTags.every(tag => sessionTags.has(tag));
  });
}

function renderSessionsView(sessions) {
  const filtered = filterByTags(sessions);
  const sorted = sortSessions(filtered);
  const allTags = collectAllTags();

  const cards = sorted.length === 0 ? `
    <div class="empty-state">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
        <rect x="2" y="3" width="20" height="18" rx="3"/>
        <circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/>
      </svg>
      <h4>${S.filterTags.length > 0 ? 'No sessions match these tags' : 'No sessions yet'}</h4>
      <p>${S.filterTags.length > 0 ? 'Try removing a filter.' : 'Save your current tabs as a session to get started.'}</p>
    </div>` : sorted.map(renderSessionCard).join('');

  const tagFilters = allTags.length > 0 ? `
    <div class="tag-filter-bar">
      ${allTags.map(tag => `
        <button class="tag-filter-chip ${S.filterTags.includes(tag) ? 'active' : ''}" data-action="toggle-filter-tag" data-tag="${esc(tag)}">${esc(tag)}</button>
      `).join('')}
    </div>` : '';

  const bulkToggle = Object.keys(S.sessions).length > 1
    ? `<button class="btn-ghost" id="bulk-toggle" style="margin-left:auto;font-size:10px">
        ${S.bulkMode ? 'Cancel' : 'Select'}
       </button>` : '';

  return `
    <div class="save-cta" id="save-cta">
      <div class="save-cta-text">
        <strong>Save current session</strong>
        <span>${S.liveGroups.length} group${S.liveGroups.length !== 1 ? 's' : ''} · ${countCurrentTabs()} tabs open</span>
      </div>
      <button class="btn-primary" id="btn-save">Save</button>
    </div>
    ${tagFilters}
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
      ${bulkToggle}
    </div>` : ''}
    ${cards}`;
}

function countCurrentTabs() {
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

  const autoBadge = session.autoSaved ? `<span class="auto-badge">auto</span>` : '';
  const pinClass = session.pinned ? ' pinned' : '';

  const checkbox = S.bulkMode ? `
    <div class="bulk-check ${S.bulkSelected.has(session.id) ? 'checked' : ''}" data-action="bulk-check" data-id="${session.id}">
      ${S.bulkSelected.has(session.id) ? '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20,6 9,17 4,12"/></svg>' : ''}
    </div>` : '';

  return `
    <div class="session-card" data-id="${session.id}" tabindex="0">
      <div class="session-card-header">
        ${checkbox}
        <button class="pin-btn${pinClass}" data-action="pin" data-id="${session.id}" title="${session.pinned ? 'Unpin' : 'Pin to top'}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="${session.pinned ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26"/></svg>
        </button>
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
  if (S.liveGroups.length === 0 && S.liveUngrouped.length === 0) return `
    <div class="empty-state">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
        <path d="M4 6h16M4 12h16M4 18h7"/>
      </svg>
      <h4>No tab groups</h4>
      <p>Create tab groups in Chrome by right-clicking a tab and selecting "Add to group".</p>
    </div>`;

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
      <div class="live-group-tabs">${S.liveUngrouped.map(renderLiveTab).join('')}</div>
    </div>` : '';

  return S.liveGroups.map(g => renderLiveGroupCard(g)).join('') + ungroupedSection;
}

function renderLiveTab(t) {
  return `
    <div class="live-tab-item">
      ${t.favicon
        ? `<img class="tab-favicon" src="${esc(t.favicon)}" alt="" onerror="this.style.display='none'">`
        : `<div class="tab-favicon-fallback"><svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10"/></svg></div>`}
      <div class="live-tab-info">
        <div class="live-tab-title" title="${esc(t.title)}">${esc(t.title)}</div>
        <div class="live-tab-url" title="${esc(t.url)}">${esc(truncateUrl(t.url))}</div>
      </div>
    </div>`;
}

function renderLiveGroupCard(g) {
  const colorHex = groupColorHex(g.color);
  const expanded = S.expanded.has(`live-${g.id}`);
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
      <div class="live-group-tabs">${g.tabs.map(renderLiveTab).join('')}</div>
    </div>`;
}

// ─── Detail View ──────────────────────────────────────────────────────────────
function renderDetailView() {
  const session = S.sessions[S.detailSessionId];
  if (!session) { S.view = 'sessions'; return renderSessionsView(Object.values(S.sessions)); }

  const groups = (session.groups ?? []).map((g, i) => renderDetailGroup(g, session.id, i)).join('');
  const ungrouped = session.ungroupedTabs ?? [];
  const ungroupedSection = ungrouped.length > 0 ? `
    <div class="detail-group">
      <div class="detail-group-header">
        <span class="detail-group-name">Ungrouped</span>
        <span class="live-group-count">${ungrouped.length} tab${ungrouped.length !== 1 ? 's' : ''}</span>
      </div>
      ${ungrouped.map((tab, i) => renderDetailTab(tab, null, session.id, i)).join('')}
    </div>` : '';

  const body = groups + ungroupedSection || `<p class="text-muted" style="text-align:center;margin-top:24px;font-size:12px">No groups in this session.</p>`;

  const versionsBtn = `<button class="btn-ghost" data-action="toggle-versions" data-session-id="${session.id}" style="font-size:10.5px">
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><polyline points="12,6 12,12 16,14"/></svg>
    History
  </button>`;

  return `
    <div class="detail-back" data-action="back">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15,18 9,12 15,6"/></svg>
      <span>${esc(session.name)}</span>
    </div>
    <div class="detail-toolbar">
      <button class="btn-secondary detail-add-tab" data-action="add-current-tab" data-session-id="${session.id}">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Add current tab
      </button>
      ${versionsBtn}
    </div>
    ${S.showVersions ? renderVersionsSection(session.id) : ''}
    ${body}`;
}

function renderDetailGroup(group, sessionId, groupIndex) {
  const colorHex = groupColorHex(group.color);
  const tags = (group.tags ?? []).map((tag, i) => `
    <span class="tag-chip">
      ${esc(tag)}
      <button class="tag-remove" data-action="remove-group-tag"
        data-session-id="${sessionId}" data-group-id="${group.id}" data-tag-index="${i}">×</button>
    </span>`).join('');

  return `
    <div class="detail-group" draggable="true" data-group-id="${group.id}" data-group-index="${groupIndex}">
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
      ${(group.tabs ?? []).map((tab, i) => renderDetailTab(tab, group.id, sessionId, i)).join('')}
    </div>`;
}

function renderDetailTab(tab, groupId, sessionId, tabIndex) {
  return `
    <div class="detail-tab" draggable="true" data-tab-id="${tab.id}" data-group-id="${groupId ?? ''}" data-tab-index="${tabIndex}">
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

// ─── Version History ──────────────────────────────────────────────────────────
function renderVersionsSection(sessionId) {
  // Will be populated async; use a placeholder
  const container = `<div class="version-list" id="version-list" data-session-id="${sessionId}">
    <div class="text-muted" style="font-size:11px;text-align:center;padding:8px">Loading history…</div>
  </div>`;
  // Kick off async load after render
  requestAnimationFrame(() => loadVersions(sessionId));
  return container;
}

async function loadVersions(sessionId) {
  const el = document.getElementById('version-list');
  if (!el) return;
  const versions = await StorageManager.getVersions(sessionId);
  if (versions.length === 0) {
    el.innerHTML = `<div class="text-muted" style="font-size:11px;text-align:center;padding:8px">No version history yet. Versions are saved when you re-capture a session.</div>`;
    return;
  }
  el.innerHTML = versions.map((v, i) => {
    const tabs = (v.snapshot.metadata?.tabCount ?? 0);
    const groups = (v.snapshot.metadata?.groupCount ?? 0);
    return `
      <div class="version-item">
        <div>
          <div class="version-date">${formatDate(v.savedAt)}</div>
          <div class="version-meta">${groups} groups · ${tabs} tabs</div>
        </div>
        <button class="btn-ghost" data-action="restore-version" data-session-id="${sessionId}" data-version-index="${i}">Restore</button>
      </div>`;
  }).join('');
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
    <div id="search-results">${resultsHtml}</div>`;
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

// ─── Trash View ──────────────────────────────────────────────────────────────
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

// ─── Settings View ───────────────────────────────────────────────────────────
function renderSettingsView() {
  return `
    <div class="detail-back" data-action="back-to-sessions">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15,18 9,12 15,6"/></svg>
      <span>Settings</span>
    </div>
    <div class="settings-panel">
      <div class="settings-group">
        <div class="settings-group-title">Auto-save</div>
        <div class="settings-row">
          <div class="settings-label">
            Periodic auto-save
            <small>Saves all windows at a set interval</small>
          </div>
          <select class="settings-select" id="settings-autosave">
            <option value="0"  ${S.autoSaveMinutes === 0  ? 'selected' : ''}>Off</option>
            <option value="5"  ${S.autoSaveMinutes === 5  ? 'selected' : ''}>Every 5 min</option>
            <option value="15" ${S.autoSaveMinutes === 15 ? 'selected' : ''}>Every 15 min</option>
            <option value="30" ${S.autoSaveMinutes === 30 ? 'selected' : ''}>Every 30 min</option>
            <option value="60" ${S.autoSaveMinutes === 60 ? 'selected' : ''}>Every hour</option>
          </select>
        </div>
      </div>
      <div class="settings-group">
        <div class="settings-group-title">Sync</div>
        <div class="settings-row">
          <div class="settings-label">
            Sync settings across devices
            <small>Theme, sort, and preferences via Chrome Sync</small>
          </div>
          <button class="toggle-switch ${S.syncEnabled ? 'on' : ''}" id="settings-sync"></button>
        </div>
      </div>
      <div class="settings-group">
        <div class="settings-group-title">Keyboard shortcuts</div>
        <div class="settings-row" style="flex-direction:column;align-items:flex-start;gap:4px">
          <div style="display:flex;gap:8px;align-items:center;width:100%">
            <span class="kbd-hint">/</span>
            <span class="settings-label">Focus search</span>
          </div>
          <div style="display:flex;gap:8px;align-items:center;width:100%">
            <span class="kbd-hint">↑ ↓</span>
            <span class="settings-label">Navigate sessions</span>
          </div>
          <div style="display:flex;gap:8px;align-items:center;width:100%">
            <span class="kbd-hint">Enter</span>
            <span class="settings-label">Open detail / restore</span>
          </div>
          <div style="display:flex;gap:8px;align-items:center;width:100%">
            <span class="kbd-hint">Esc</span>
            <span class="settings-label">Go back</span>
          </div>
        </div>
      </div>
    </div>`;
}

// ─── Live Groups real-time listeners ──────────────────────────────────────────
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
  const onTabCreated   = () => refresh();
  const onTabRemoved   = () => refresh();
  const onTabUpdated   = (id, change) => {
    if (change.title !== undefined || change.url !== undefined || change.groupId !== undefined) refresh();
  };
  const onGroupCreated = () => refresh();
  const onGroupRemoved = () => refresh();
  const onGroupUpdated = () => refresh();

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
      S.bulkMode = false; S.bulkSelected.clear();
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
    await saveAllSettings();
  });

  document.getElementById('btn-settings').addEventListener('click', () => {
    S.view = 'settings';
    render();
  });

  document.getElementById('btn-export-all').addEventListener('click', async () => {
    const json = await StorageManager.exportAll();
    downloadText(json, 'tabvault-backup.json');
    toast('Backup exported', 'success');
  });

  document.getElementById('btn-side-panel').addEventListener('click', async () => {
    try {
      const win = await chrome.windows.getCurrent();
      await chrome.sidePanel.open({ windowId: win.id });
      window.close();
    } catch {
      toast('Side panel requires Chrome 116+', 'error');
    }
  });

  // Import menu via reusable showMenu
  document.getElementById('btn-import').addEventListener('click', () => {
    const btn = document.getElementById('btn-import');
    const hasExisting = Object.keys(S.sessions).length > 0;
    const items = [
      {
        label: 'Merge with existing',
        icon: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
        action: () => { document.getElementById('import-file').dataset.mode = 'merge'; document.getElementById('import-file').click(); }
      }
    ];
    if (hasExisting) {
      items.push({
        label: 'Replace all',
        icon: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="1,4 1,10 7,10"/><path d="M3.51 15a9 9 0 1 0 .49-4.95"/></svg>',
        danger: true,
        action: () => { document.getElementById('import-file').dataset.mode = 'replace'; document.getElementById('import-file').click(); }
      });
    }
    showMenu(btn, items);
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
        const imported = data.sessions ?? {};
        const existing = await StorageManager.getSessions();
        const merged = { ...existing, ...imported };
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

  // Delete confirmation modal (for permanent deletes)
  document.getElementById('delete-confirm').addEventListener('click', () => confirmDelete());
  document.getElementById('delete-cancel').addEventListener('click', () => closeDeleteModal());
  document.getElementById('delete-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeDeleteModal();
  });

  // Merge modal
  document.getElementById('merge-confirm').addEventListener('click', () => confirmMerge());
  document.getElementById('merge-cancel').addEventListener('click', () => closeMergeModal());
  document.getElementById('merge-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeMergeModal();
  });
  document.getElementById('merge-name-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') confirmMerge();
    if (e.key === 'Escape') closeMergeModal();
  });

  // Bulk actions
  document.getElementById('bulk-delete').addEventListener('click', bulkDelete);
  document.getElementById('bulk-export').addEventListener('click', bulkExport);
  document.getElementById('bulk-merge').addEventListener('click', () => openMergeModal());
  document.getElementById('bulk-cancel').addEventListener('click', () => {
    S.bulkMode = false; S.bulkSelected.clear(); render();
  });

  // Undo button
  document.getElementById('undo-btn').addEventListener('click', performUndo);
}

function bindViewEvents() {
  const content = document.getElementById('content');

  document.getElementById('btn-save')?.addEventListener('click', openSaveModal);
  document.getElementById('save-cta')?.addEventListener('click', e => {
    if (!e.target.closest('button')) openSaveModal();
  });

  document.getElementById('sort-select')?.addEventListener('change', async e => {
    S.sortBy = e.target.value;
    await saveAllSettings();
    render();
  });

  document.getElementById('bulk-toggle')?.addEventListener('click', () => {
    S.bulkMode = !S.bulkMode;
    S.bulkSelected.clear();
    render();
  });

  // Search — FIX: replace container content properly instead of accumulating nodes
  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    searchInput.addEventListener('input', e => {
      S.searchQuery = e.target.value;
      const res = searchSessions(S.sessions, S.searchQuery);
      const resultsContainer = document.getElementById('search-results');
      if (resultsContainer) {
        resultsContainer.innerHTML = S.searchQuery.trim() ? renderSearchResults(res) : renderRecentTabs();
      }
    });
    searchInput.addEventListener('focus', e => e.target.select());
  }

  // Tag filter clicks
  content.querySelectorAll('[data-action="toggle-filter-tag"]').forEach(chip => {
    chip.addEventListener('click', () => {
      const tag = chip.dataset.tag;
      const idx = S.filterTags.indexOf(tag);
      if (idx !== -1) S.filterTags.splice(idx, 1);
      else S.filterTags.push(tag);
      render();
    });
  });

  // Note autosave: blur for immediate save, + debounced input as fallback if popup closes before blur
  if (S.view === 'detail') {
    content.querySelectorAll('textarea[data-action="note-group"]').forEach(el => {
      el.addEventListener('blur', () => {
        clearTimeout(el._noteTimer);
        saveNoteGroup(el.dataset.sessionId, el.dataset.groupId, el.value);
      });
      el.addEventListener('input', () => {
        clearTimeout(el._noteTimer);
        el._noteTimer = setTimeout(() => saveNoteGroup(el.dataset.sessionId, el.dataset.groupId, el.value), 500);
      });
    });
    content.querySelectorAll('textarea[data-action="note-tab"]').forEach(el => {
      el.addEventListener('blur', () => {
        clearTimeout(el._noteTimer);
        saveNoteTab(el.dataset.sessionId, el.dataset.groupId || null, el.dataset.tabId, el.value);
      });
      el.addEventListener('input', () => {
        clearTimeout(el._noteTimer);
        el._noteTimer = setTimeout(() => saveNoteTab(el.dataset.sessionId, el.dataset.groupId || null, el.dataset.tabId, el.value), 500);
      });
    });
    bindDragAndDrop();
  }

  // Settings view
  if (S.view === 'settings') {
    document.getElementById('settings-autosave')?.addEventListener('change', async e => {
      S.autoSaveMinutes = parseInt(e.target.value, 10);
      await saveAllSettings();
      toast(S.autoSaveMinutes > 0 ? `Auto-save every ${S.autoSaveMinutes}m` : 'Auto-save off', 'success');
    });
    document.getElementById('settings-sync')?.addEventListener('click', async e => {
      S.syncEnabled = !S.syncEnabled;
      e.target.classList.toggle('on', S.syncEnabled);
      await saveAllSettings();
      toast(S.syncEnabled ? 'Sync enabled' : 'Sync disabled', 'success');
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
    case 'restore-menu':      showRestoreMenu(btn, id); break;
    case 'delete':            await deleteSessionSoft(id); break;
    case 'export-menu':       showExportMenu(btn, id); break;
    case 'toggle-live-group': toggleLiveGroup(btn.dataset.groupId); break;
    case 'rename':            startRename(btn, id); break;
    case 'detail':            openDetailView(id); break;
    case 'back':              S.view = 'sessions'; S.showVersions = false; render(); break;
    case 'back-to-sessions':  S.view = 'sessions'; render(); break;
    case 'pin':               await togglePin(id); break;
    case 'bulk-check':        toggleBulkCheck(id); break;
    case 'remove-group-tag':  await removeGroupTag(btn.dataset.sessionId, btn.dataset.groupId, +btn.dataset.tagIndex); break;
    case 'add-group-tag':     startAddGroupTag(btn); break;
    case 'remove-tab':        await removeTab(btn.dataset.sessionId, btn.dataset.groupId || null, btn.dataset.tabId); break;
    case 'remove-group':      await removeGroup(btn.dataset.sessionId, btn.dataset.groupId); break;
    case 'add-current-tab':   await addCurrentTab(btn.dataset.sessionId); break;
    case 'restore-trash':     await restoreFromTrash(btn.dataset.id); break;
    case 'delete-permanent':  openDeleteModal(btn.dataset.id); break;
    case 'toggle-versions':   S.showVersions = !S.showVersions; render(); break;
    case 'restore-version':   await restoreVersionAction(btn.dataset.sessionId, +btn.dataset.versionIndex); break;
  }
}

function handleDoubleClick(e) {
  const nameEl = e.target.closest('.session-name');
  if (nameEl) startRename(nameEl, nameEl.dataset.id);
}

// ─── Settings helper ─────────────────────────────────────────────────────────
async function saveAllSettings() {
  const settings = {
    theme: S.theme,
    sortBy: S.sortBy,
    autoSaveMinutes: S.autoSaveMinutes,
    syncEnabled: S.syncEnabled
  };
  await StorageManager.saveSettings(settings);
}

// ─── Actions ──────────────────────────────────────────────────────────────────
function openSaveModal() {
  const modal = document.getElementById('save-modal');
  const input = document.getElementById('session-name-input');
  const now = new Date();
  input.value = `${now.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} session`;
  modal.removeAttribute('hidden');
  requestAnimationFrame(() => { input.focus(); input.select(); });
}

function closeSaveModal() {
  delete document.getElementById('modal-confirm')._duplicateAcknowledged;
  document.getElementById('duplicate-warning').setAttribute('hidden', '');
  document.getElementById('save-modal').setAttribute('hidden', '');
}

async function confirmSave() {
  const name = document.getElementById('session-name-input').value.trim() || 'Untitled Session';
  const confirmBtn = document.getElementById('modal-confirm');
  const warningEl = document.getElementById('duplicate-warning');

  if (!confirmBtn._duplicateAcknowledged) {
    const duplicate = findDuplicateSession();
    if (duplicate) {
      // Save version of existing duplicate before overwrite
      await StorageManager.saveVersion(duplicate.id);
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
      StorageManager.invalidate();
      S.sessions = await StorageManager.getSessions();
      render();
      toast(`"${name}" saved`, 'success');
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

function showRestoreMenu(btn, id) {
  showMenu(btn, [
    {
      label: 'New window',
      icon: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="2" y="3" width="20" height="18" rx="2"/><path d="M2 9h20"/></svg>',
      action: () => restoreSession(id)
    },
    {
      label: 'This window',
      icon: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M5 3l14 9-14 9V3z"/></svg>',
      action: async () => {
        const win = await chrome.windows.getCurrent();
        await restoreSessionInWindow(id, win.id);
      }
    }
  ]);
}

// ─── Undo-based soft delete ──────────────────────────────────────────────────
async function deleteSessionSoft(id) {
  if (!S.sessions[id]) return;
  const session = S.sessions[id];
  const sessionBackup = { ...session };

  // Immediately delete
  await StorageManager.deleteSession(id);
  S.trash[id] = { ...session, deletedAt: Date.now() };
  delete S.sessions[id];

  // Animate card out
  const card = document.querySelector(`.session-card[data-id="${id}"]`);
  if (card) {
    card.style.transition = 'opacity 0.2s, transform 0.2s';
    card.style.opacity = '0'; card.style.transform = 'translateX(8px)';
    setTimeout(() => render(), 220);
  } else {
    render();
  }

  // Show undo toast
  showUndoToast(`"${session.name}" deleted`, async () => {
    // Undo: restore from trash
    const restored = await StorageManager.restoreFromTrash(id);
    S.sessions[restored.id] = restored;
    delete S.trash[id];
    render();
    toast(`"${restored.name}" restored`, 'success');
  });
}

function showUndoToast(msg, undoFn) {
  clearUndo();
  const el = document.getElementById('undo-toast');
  const msgEl = document.getElementById('undo-toast-msg');
  const progressEl = document.getElementById('undo-progress');

  msgEl.textContent = msg;
  el.removeAttribute('hidden');

  // Reset animation
  progressEl.style.animation = 'none';
  requestAnimationFrame(() => { progressEl.style.animation = ''; });

  S.undoAction = {
    fn: undoFn,
    timer: setTimeout(() => {
      el.setAttribute('hidden', '');
      S.undoAction = null;
    }, 5000)
  };
}

function performUndo() {
  if (!S.undoAction) return;
  clearTimeout(S.undoAction.timer);
  const fn = S.undoAction.fn;
  S.undoAction = null;
  document.getElementById('undo-toast').setAttribute('hidden', '');
  fn();
}

function clearUndo() {
  if (S.undoAction) {
    clearTimeout(S.undoAction.timer);
    S.undoAction = null;
  }
  document.getElementById('undo-toast')?.setAttribute('hidden', '');
}

// ─── Permanent delete (with confirmation modal) ──────────────────────────────
let _pendingDeleteId = null;
let _pendingDeletePermanent = false;

function openDeleteModal(id) {
  _pendingDeleteId = id;
  _pendingDeletePermanent = true;
  const session = S.trash[id];
  document.getElementById('delete-modal-title').textContent = 'Delete Permanently';
  document.getElementById('delete-modal-desc').textContent =
    `"${session?.name ?? 'This session'}" will be permanently deleted. This cannot be undone.`;
  document.getElementById('delete-modal').removeAttribute('hidden');
}

function closeDeleteModal() {
  _pendingDeleteId = null;
  _pendingDeletePermanent = false;
  document.getElementById('delete-modal').setAttribute('hidden', '');
}

async function confirmDelete() {
  const id = _pendingDeleteId;
  const isPermanent = _pendingDeletePermanent;
  closeDeleteModal();
  if (!id) return;

  if (isPermanent) {
    await StorageManager.deletePermanently(id);
    delete S.trash[id];
    render();
    toast('Permanently deleted');
  }
}

// ─── Export menu (reusable) ──────────────────────────────────────────────────
function showExportMenu(btn, id) {
  const session = S.sessions[id];
  if (!session) return;
  showMenu(btn, [
    {
      label: 'Export JSON',
      action: async () => {
        const json = await StorageManager.exportSession(id);
        downloadText(json, `${sanitizeName(session.name)}.json`);
        toast('Exported as JSON', 'success');
      }
    },
    {
      label: 'Export Markdown',
      action: () => {
        const md = StorageManager.exportAsMarkdown(session);
        downloadText(md, `${sanitizeName(session.name)}.md`);
        toast('Exported as Markdown', 'success');
      }
    }
  ]);
}

// ─── Pin / Favorite ──────────────────────────────────────────────────────────
async function togglePin(id) {
  const pinned = await StorageManager.togglePin(id);
  S.sessions[id].pinned = pinned;
  render();
  toast(pinned ? 'Pinned' : 'Unpinned', 'success');
}

// ─── Bulk Operations ─────────────────────────────────────────────────────────
function toggleBulkCheck(id) {
  if (S.bulkSelected.has(id)) S.bulkSelected.delete(id);
  else S.bulkSelected.add(id);
  document.getElementById('bulk-count').textContent = `${S.bulkSelected.size} selected`;
  // Update checkbox visual
  const check = document.querySelector(`.bulk-check[data-id="${id}"]`);
  if (check) {
    check.classList.toggle('checked', S.bulkSelected.has(id));
    check.innerHTML = S.bulkSelected.has(id)
      ? '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20,6 9,17 4,12"/></svg>'
      : '';
  }
}

async function bulkDelete() {
  if (S.bulkSelected.size === 0) return;
  const ids = [...S.bulkSelected];
  const count = ids.length;
  const { sessions, trash } = await StorageManager.deleteSessions(ids);
  S.sessions = sessions;
  S.trash = { ...S.trash, ...Object.fromEntries(ids.filter(id => trash[id]).map(id => [id, trash[id]])) };
  S.bulkMode = false; S.bulkSelected.clear();
  render();

  // Undo for bulk
  showUndoToast(`${count} sessions deleted`, async () => {
    for (const id of ids) {
      try {
        const restored = await StorageManager.restoreFromTrash(id);
        S.sessions[restored.id] = restored;
        delete S.trash[id];
      } catch { /* some might already be restored */ }
    }
    render();
    toast(`${count} sessions restored`, 'success');
  });
}

async function bulkExport() {
  if (S.bulkSelected.size === 0) return;
  const exportData = { _tabvault: true, version: 2, sessions: {} };
  for (const id of S.bulkSelected) {
    if (S.sessions[id]) exportData.sessions[id] = S.sessions[id];
  }
  const json = JSON.stringify(exportData, null, 2);
  downloadText(json, `tabvault-${S.bulkSelected.size}-sessions.json`);
  S.bulkMode = false; S.bulkSelected.clear();
  render();
  toast(`Exported ${Object.keys(exportData.sessions).length} sessions`, 'success');
}

// ─── Merge ───────────────────────────────────────────────────────────────────
function openMergeModal() {
  if (S.bulkSelected.size < 2) { toast('Select at least 2 sessions to merge', 'error'); return; }
  const names = [...S.bulkSelected].map(id => S.sessions[id]?.name).filter(Boolean);
  document.getElementById('merge-desc').textContent = `Merging: ${names.join(', ')}`;
  document.getElementById('merge-name-input').value = `Merged (${names.length} sessions)`;
  document.getElementById('merge-modal').removeAttribute('hidden');
  requestAnimationFrame(() => {
    const input = document.getElementById('merge-name-input');
    input.focus(); input.select();
  });
}

function closeMergeModal() {
  document.getElementById('merge-modal').setAttribute('hidden', '');
}

async function confirmMerge() {
  const name = document.getElementById('merge-name-input').value.trim() || 'Merged Session';
  const ids = [...S.bulkSelected];
  closeMergeModal();

  const merged = await StorageManager.mergeSessions(ids, name);
  S.sessions[merged.id] = merged;
  S.bulkMode = false; S.bulkSelected.clear();
  render();
  toast(`Merged ${ids.length} sessions`, 'success');
}

// ─── Versioning ──────────────────────────────────────────────────────────────
async function restoreVersionAction(sessionId, versionIndex) {
  try {
    const restored = await StorageManager.restoreVersion(sessionId, versionIndex);
    S.sessions[sessionId] = restored;
    render();
    toast('Version restored', 'success');
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ─── Misc actions ────────────────────────────────────────────────────────────
function toggleLiveGroup(groupId) {
  const key = `live-${groupId}`;
  if (S.expanded.has(key)) S.expanded.delete(key);
  else S.expanded.add(key);
  const card = document.querySelector(`.live-group-card[data-group-id="${groupId}"]`);
  if (card) card.classList.toggle('expanded', S.expanded.has(key));
}

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

function openDetailView(id) {
  S.detailSessionId = id;
  S.view = 'detail';
  S.showVersions = false;
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
  let favicon = '';
  try {
    const res = await chrome.runtime.sendMessage({ type: 'CONVERT_FAVICON', url: tab.favIconUrl || '' });
    favicon = res?.dataUrl ?? '';
  } catch { favicon = ''; }
  const tabData = {
    id: StorageManager.generateId(),
    url: tab.url,
    title: tab.title || tab.url,
    favicon,
    note: '',
    tags: [],
    savedAt: Date.now()
  };
  const updated = await StorageManager.addTabToSession(sessionId, tabData);
  S.sessions[sessionId] = updated;
  render();
  toast('Tab added', 'success');
}

async function restoreFromTrash(id) {
  const session = await StorageManager.restoreFromTrash(id);
  S.sessions[session.id] = session;
  delete S.trash[id];
  render();
  toast(`"${session.name}" restored`, 'success');
}

// ─── Drag & Drop ──────────────────────────────────────────────────────────────
function bindDragAndDrop() {
  const content = document.getElementById('content');
  let dragData = null;

  content.addEventListener('dragstart', e => {
    const tabEl = e.target.closest('.detail-tab[draggable]');
    const groupEl = e.target.closest('.detail-group[draggable]');

    if (tabEl) {
      dragData = {
        type: 'tab',
        tabId: tabEl.dataset.tabId,
        groupId: tabEl.dataset.groupId || null,
        tabIndex: parseInt(tabEl.dataset.tabIndex, 10)
      };
      tabEl.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', 'tab');
    } else if (groupEl && !e.target.closest('.detail-tab')) {
      dragData = {
        type: 'group',
        groupId: groupEl.dataset.groupId,
        groupIndex: parseInt(groupEl.dataset.groupIndex, 10)
      };
      groupEl.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', 'group');
    }
  });

  content.addEventListener('dragover', e => {
    if (!dragData) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    // Clear previous indicators
    content.querySelectorAll('.drag-over-top, .drag-over-bottom, .drag-over').forEach(el => {
      el.classList.remove('drag-over-top', 'drag-over-bottom', 'drag-over');
    });

    if (dragData.type === 'tab') {
      const target = e.target.closest('.detail-tab');
      if (target && !target.classList.contains('dragging')) {
        const rect = target.getBoundingClientRect();
        const mid = rect.top + rect.height / 2;
        target.classList.add(e.clientY < mid ? 'drag-over-top' : 'drag-over-bottom');
      }
      // Drop on group header to move tab to that group
      const groupHeader = e.target.closest('.detail-group-header');
      if (groupHeader) {
        const groupEl = groupHeader.closest('.detail-group');
        if (groupEl) groupEl.classList.add('drag-over');
      }
    } else if (dragData.type === 'group') {
      const target = e.target.closest('.detail-group');
      if (target && !target.classList.contains('dragging')) {
        target.classList.add('drag-over');
      }
    }
  });

  content.addEventListener('dragleave', e => {
    const target = e.target.closest('.detail-tab, .detail-group');
    if (target) {
      target.classList.remove('drag-over-top', 'drag-over-bottom', 'drag-over');
    }
  });

  content.addEventListener('drop', async e => {
    e.preventDefault();
    content.querySelectorAll('.drag-over-top, .drag-over-bottom, .drag-over, .dragging').forEach(el => {
      el.classList.remove('drag-over-top', 'drag-over-bottom', 'drag-over', 'dragging');
    });

    if (!dragData || !S.detailSessionId) return;

    const sessionId = S.detailSessionId;

    if (dragData.type === 'tab') {
      const targetTab = e.target.closest('.detail-tab');
      const targetGroupHeader = e.target.closest('.detail-group-header');

      if (targetTab) {
        const toGroupId = targetTab.dataset.groupId || null;
        const toIndex = parseInt(targetTab.dataset.tabIndex, 10);

        if (dragData.groupId === toGroupId) {
          // Reorder within same group
          const updated = await StorageManager.reorderTabs(sessionId, toGroupId, dragData.tabIndex, toIndex);
          if (updated) S.sessions[sessionId] = updated;
        } else {
          // Move between groups
          const updated = await StorageManager.moveTabToGroup(sessionId, dragData.tabId, dragData.groupId, toGroupId);
          if (updated) S.sessions[sessionId] = updated;
        }
        render();
      } else if (targetGroupHeader) {
        // Move tab into a different group
        const groupEl = targetGroupHeader.closest('.detail-group');
        const toGroupId = groupEl?.dataset.groupId || null;
        if (toGroupId && toGroupId !== dragData.groupId) {
          const updated = await StorageManager.moveTabToGroup(sessionId, dragData.tabId, dragData.groupId, toGroupId);
          if (updated) S.sessions[sessionId] = updated;
          render();
        }
      }
    } else if (dragData.type === 'group') {
      const targetGroup = e.target.closest('.detail-group');
      if (targetGroup) {
        const toIndex = parseInt(targetGroup.dataset.groupIndex, 10);
        if (!isNaN(toIndex) && toIndex !== dragData.groupIndex) {
          const updated = await StorageManager.reorderGroups(sessionId, dragData.groupIndex, toIndex);
          if (updated) S.sessions[sessionId] = updated;
          render();
        }
      }
    }

    dragData = null;
  });

  content.addEventListener('dragend', () => {
    dragData = null;
    content.querySelectorAll('.drag-over-top, .drag-over-bottom, .drag-over, .dragging').forEach(el => {
      el.classList.remove('drag-over-top', 'drag-over-bottom', 'drag-over', 'dragging');
    });
  });
}

// ─── Keyboard Navigation ──────────────────────────────────────────────────────
function bindKeyboardNav() {
  document.addEventListener('keydown', e => {
    // Global shortcuts
    if (e.key === '/' && !isEditing()) {
      e.preventDefault();
      if (S.view !== 'search') {
        S.view = 'search';
        render();
      }
      requestAnimationFrame(() => document.getElementById('search-input')?.focus());
      return;
    }

    if (e.key === 'Escape') {
      if (S.view === 'detail') { S.view = 'sessions'; S.showVersions = false; render(); return; }
      if (S.view === 'settings') { S.view = 'sessions'; render(); return; }
      if (S.bulkMode) { S.bulkMode = false; S.bulkSelected.clear(); render(); return; }
      closeMenu();
      return;
    }

    // Arrow navigation in sessions view
    if (S.view === 'sessions' && !isEditing()) {
      const cards = document.querySelectorAll('.session-card');
      if (cards.length === 0) return;

      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        S.kbIndex = Math.min(S.kbIndex + 1, cards.length - 1);
        updateKbFocus(cards);
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        S.kbIndex = Math.max(S.kbIndex - 1, 0);
        updateKbFocus(cards);
      } else if (e.key === 'Enter' && S.kbIndex >= 0) {
        e.preventDefault();
        const id = cards[S.kbIndex]?.dataset.id;
        if (id) openDetailView(id);
      } else if (e.key === 'r' && S.kbIndex >= 0) {
        const id = cards[S.kbIndex]?.dataset.id;
        if (id) restoreSession(id);
      }
    }
  });
}

function updateKbFocus(cards) {
  cards.forEach((c, i) => {
    c.classList.toggle('kb-focus', i === S.kbIndex);
  });
  cards[S.kbIndex]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function isEditing() {
  const el = document.activeElement;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.getAttribute('contenteditable') === 'true';
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
