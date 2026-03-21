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
  liveGroups: [],
  searchQuery: '',
  loading: true,
  expanded: new Set(),      // expanded card/group IDs
  toastTimer: null
};

// ─── Init ────────────────────────────────────────────────────────────────────
async function init() {
  renderLoading();
  try {
    [S.sessions, S.liveGroups] = await Promise.all([
      StorageManager.getSessions(),
      captureLiveGroups()
    ]);
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
  for (const t of tabs) {
    const tab = { id: t.id, url: t.url || '', title: t.title || t.url || '…', favicon: t.favIconUrl || '' };
    if (t.groupId > 0 && map.has(t.groupId)) map.get(t.groupId).tabs.push(tab);
  }
  return [...map.values()];
}

// ─── Top-level render ────────────────────────────────────────────────────────
function render() {
  const el = document.getElementById('content');
  const sessionArr = Object.values(S.sessions);

  // Update sessions badge
  const badge = document.getElementById('sessions-count');
  badge.textContent = sessionArr.length > 0 ? sessionArr.length : '';

  // Active nav tab
  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === S.view);
  });

  if (S.view === 'sessions') el.innerHTML = renderSessionsView(sessionArr);
  else if (S.view === 'groups') el.innerHTML = renderGroupsView();
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
function renderSessionsView(sessions) {
  const sorted = [...sessions].sort((a, b) => b.updated - a.updated);

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
    ${cards}`;
}

function countCurrentTabs() {
  return S.liveGroups.reduce((n, g) => n + g.tabs.length, 0);
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
  const more = (session.groups?.length ?? 0) > 5 ? `<span class="group-pill text-muted">+${session.groups.length - 5}</span>` : '';

  return `
    <div class="session-card" data-id="${session.id}">
      <div class="session-card-header">
        <div class="session-card-info">
          <div class="session-name no-select" data-action="rename" data-id="${session.id}" title="Click to rename">${esc(session.name)}</div>
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
          <button class="btn-ghost" data-action="restore" data-id="${session.id}" title="Restore in new window">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M5 3l14 9-14 9V3z"/></svg>
            Restore
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
  if (S.liveGroups.length === 0) return `
    <div class="empty-state">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
        <path d="M4 6h16M4 12h16M4 18h7"/>
      </svg>
      <h4>No tab groups</h4>
      <p>Create tab groups in Chrome by right-clicking a tab and selecting "Add to group".</p>
    </div>`;

  return S.liveGroups.map(g => renderLiveGroupCard(g)).join('');
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
      // Session name matched
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
            <img class="tab-favicon" src="https://www.google.com/s2/favicons?domain=${esc(new URL(tab.url).hostname)}&sz=32" alt="" onerror="this.style.display='none'" width="14" height="14">
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
      const hostname = new URL(tab.url).hostname;
      return `
        <a class="search-tab-item" href="${esc(tab.url)}" target="_blank">
          <img class="tab-favicon" src="https://www.google.com/s2/favicons?domain=${hostname}&sz=32" alt="" onerror="this.style.display='none'" width="14" height="14">
          <div class="search-tab-info">
            <div class="search-tab-title">${esc(tab.title || tab.url)}</div>
            <div class="search-tab-meta"><span class="search-tab-url">${esc(truncateUrl(tab.url))}</span></div>
          </div>
        </a>`;
    } catch { return ''; }
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

// ─── Event Binding ───────────────────────────────────────────────────────────
function bindStaticEvents() {
  // Nav tab switching
  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      S.view = btn.dataset.view;
      render();
      if (S.view === 'search') {
        requestAnimationFrame(() => document.getElementById('search-input')?.focus());
      }
    });
  });

  // Export all
  document.getElementById('btn-export-all').addEventListener('click', async () => {
    const json = await StorageManager.exportAll();
    downloadText(json, 'tabvault-backup.json');
    toast('Backup exported', 'success');
  });

  // Import
  document.getElementById('btn-import').addEventListener('click', () => {
    document.getElementById('import-file').click();
  });
  document.getElementById('import-file').addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await readFileAsText(file);
      await StorageManager.importAll(text);
      S.sessions = await StorageManager.getSessions();
      render();
      toast(`Imported ${Object.keys(S.sessions).length} sessions`, 'success');
    } catch (err) {
      toast(`Import failed: ${err.message}`, 'error');
    }
    e.target.value = '';
  });

  // Save modal confirm
  document.getElementById('modal-confirm').addEventListener('click', () => confirmSave());
  document.getElementById('modal-cancel').addEventListener('click', () => closeSaveModal());
  document.getElementById('session-name-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') confirmSave();
    if (e.key === 'Escape') closeSaveModal();
  });
  document.getElementById('save-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeSaveModal();
  });
}

function bindViewEvents() {
  const content = document.getElementById('content');

  // Save button in sessions view
  document.getElementById('btn-save')?.addEventListener('click', openSaveModal);
  document.getElementById('save-cta')?.addEventListener('click', e => {
    if (!e.target.closest('button')) openSaveModal();
  });

  // Search input
  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    searchInput.addEventListener('input', e => {
      S.searchQuery = e.target.value;
      const res = searchSessions(S.sessions, S.searchQuery);
      const rContainer = content.querySelector('.search-bar');
      // Re-render only results below search bar
      const after = rContainer.nextSibling;
      if (after) after.remove();
      const div = document.createElement('div');
      div.innerHTML = S.searchQuery.trim() ? renderSearchResults(res) : renderRecentTabs();
      [...div.childNodes].forEach(n => content.appendChild(n));
    });
    searchInput.addEventListener('focus', e => e.target.select());
  }

  // Delegated events on content
  content.addEventListener('click', handleContentClick);
  content.addEventListener('dblclick', handleDoubleClick);
}

async function handleContentClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;

  const action = btn.dataset.action;
  const id = btn.dataset.id;

  switch (action) {
    case 'restore': await restoreSession(id); break;
    case 'delete':  await deleteSession(id); break;
    case 'export-menu': await exportSession(id); break;
    case 'toggle-live-group': toggleLiveGroup(btn.dataset.groupId); break;
    case 'rename': startRename(btn, id); break;
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
  input.value = `${now.toLocaleDateString('en', { month: 'short', day: 'numeric' })} session`;
  modal.removeAttribute('hidden');
  requestAnimationFrame(() => { input.focus(); input.select(); });
}

function closeSaveModal() {
  document.getElementById('save-modal').setAttribute('hidden', '');
}

async function confirmSave() {
  const name = document.getElementById('session-name-input').value.trim() || 'Untitled Session';
  closeSaveModal();

  const btn = document.getElementById('btn-save');
  if (btn) { btn.textContent = 'Saving…'; btn.disabled = true; }

  try {
    const result = await chrome.runtime.sendMessage({ type: 'CAPTURE_SESSION', name });
    if (result?.ok) {
      S.sessions = await StorageManager.getSessions();
      render();
      toast(`"${name}" saved`, 'success');
    } else {
      toast(result?.error ?? 'Save failed', 'error');
    }
  } catch (e) {
    toast('Could not save session', 'error');
  }
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

async function deleteSession(id) {
  const session = S.sessions[id];
  if (!session) return;

  // Simple confirm using the card itself (no native dialog)
  const card = document.querySelector(`.session-card[data-id="${id}"]`);
  if (!card) return;

  const delBtn = card.querySelector('[data-action="delete"]');
  if (delBtn._confirmPending) {
    clearTimeout(delBtn._confirmTimer);
    delete delBtn._confirmPending;
    delBtn.textContent = '…';
    await StorageManager.deleteSession(id);
    delete S.sessions[id];
    card.style.transition = 'opacity 0.2s, transform 0.2s';
    card.style.opacity = '0'; card.style.transform = 'translateX(8px)';
    setTimeout(() => { card.remove(); document.getElementById('sessions-count').textContent = Object.keys(S.sessions).length || ''; }, 200);
    toast('Session deleted');
  } else {
    delBtn._confirmPending = true;
    const origContent = delBtn.innerHTML;
    delBtn.innerHTML = '<span style="color:var(--danger);font-size:10px">Confirm?</span>';
    delBtn._confirmTimer = setTimeout(() => {
      delBtn.innerHTML = origContent;
      delete delBtn._confirmPending;
    }, 2500);
  }
}

async function exportSession(id) {
  const session = S.sessions[id];
  if (!session) return;

  // Toggle mini menu
  const btn = document.querySelector(`[data-action="export-menu"][data-id="${id}"]`);
  if (!btn) return;

  // Remove existing menu
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

  // Close on outside click
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

function startRename(el, id) {
  el.setAttribute('contenteditable', 'true');
  el.classList.add('editing');
  el.focus();

  // Select all text
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  const finish = async (save) => {
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
  }, { once: false });

  el.addEventListener('blur', () => finish(true), { once: true });
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
