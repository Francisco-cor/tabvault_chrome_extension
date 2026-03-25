// shared/storage.js — Central persistence layer for TabVault
// Schema:
//   chrome.storage.local = {
//     sessions: { [id]: Session },
//     trash:    { [id]: Session & { deletedAt: number } },
//     settings: Settings
//   }
//
// Session = {
//   id, name, created, updated, autoSaved?,
//   groups: Group[],
//   ungroupedTabs: Tab[],
//   metadata: { groupCount, tabCount }
// }
// Group = { id, name, color, tags, note, tabs: Tab[] }
// Tab   = { id, url, title, favicon, note, tags, savedAt }

export const StorageManager = {
  // #11: in-memory cache — eliminates the get→set round trip on every write.
  // Valid for the lifetime of the JS context (popup or service worker).
  // Must be invalidated when another context writes to storage (see invalidate()).
  _cache: null,

  generateId() {
    return crypto.randomUUID();
  },

  // ─── Sessions ──────────────────────────────────────────────────────────────

  async getSessions() {
    if (this._cache !== null) return this._cache;
    const r = await chrome.storage.local.get('sessions');
    this._cache = r.sessions ?? {};
    return this._cache;
  },

  // Force a fresh read from storage — call this after cross-context writes
  // (e.g. after the service worker saves a captured session).
  invalidate() {
    this._cache = null;
  },

  async getSession(id) {
    const sessions = await this.getSessions();
    return sessions[id] ?? null;
  },

  // All write operations use the cached sessions object, so only one
  // chrome.storage.local.set() call is needed per operation (no extra get).
  async saveSession(session) {
    const sessions = await this.getSessions();
    sessions[session.id] = { ...session, updated: Date.now() };
    await chrome.storage.local.set({ sessions });
    return sessions[session.id];
  },

  async updateSession(id, patch) {
    const sessions = await this.getSessions();
    if (!sessions[id]) throw new Error(`Session ${id} not found`);
    sessions[id] = { ...sessions[id], ...patch, updated: Date.now() };
    await chrome.storage.local.set({ sessions });
    return sessions[id];
  },

  // Soft-delete: moves session to trash with deletedAt timestamp
  async deleteSession(id) {
    const sessions = await this.getSessions();
    const session = sessions[id];
    if (!session) return;
    delete sessions[id];
    const r = await chrome.storage.local.get('trash');
    const trash = r.trash ?? {};
    trash[id] = { ...session, deletedAt: Date.now() };
    await chrome.storage.local.set({ sessions, trash });
  },

  // ─── Trash ─────────────────────────────────────────────────────────────────

  async getTrash() {
    const r = await chrome.storage.local.get('trash');
    return r.trash ?? {};
  },

  async restoreFromTrash(id) {
    const r = await chrome.storage.local.get('trash');
    const trash = r.trash ?? {};
    const session = trash[id];
    if (!session) throw new Error('Not in trash');
    const { deletedAt, ...restored } = session;
    delete trash[id];
    const sessions = await this.getSessions();
    sessions[id] = { ...restored, updated: Date.now() };
    await chrome.storage.local.set({ sessions, trash });
    return sessions[id];
  },

  async deletePermanently(id) {
    const r = await chrome.storage.local.get('trash');
    const trash = r.trash ?? {};
    delete trash[id];
    await chrome.storage.local.set({ trash });
  },

  // Auto-purge sessions deleted more than daysOld days ago
  async purgeOldTrash(daysOld = 30) {
    const r = await chrome.storage.local.get('trash');
    const trash = r.trash ?? {};
    const cutoff = Date.now() - daysOld * 24 * 60 * 60 * 1000;
    let changed = false;
    for (const [id, session] of Object.entries(trash)) {
      if (session.deletedAt < cutoff) { delete trash[id]; changed = true; }
    }
    if (changed) await chrome.storage.local.set({ trash });
  },

  // ─── Session editing (#5) ───────────────────────────────────────────────────

  async removeTabFromSession(sessionId, groupId, tabId) {
    const sessions = await this.getSessions();
    const session = sessions[sessionId];
    if (!session) throw new Error('Session not found');
    if (groupId) {
      const group = session.groups?.find(g => g.id === groupId);
      if (group) group.tabs = group.tabs.filter(t => t.id !== tabId);
      // Remove group if it becomes empty
      session.groups = (session.groups ?? []).filter(g => g.tabs.length > 0);
    } else {
      session.ungroupedTabs = (session.ungroupedTabs ?? []).filter(t => t.id !== tabId);
    }
    const tabCount = (session.groups ?? []).reduce((n, g) => n + g.tabs.length, 0) +
                     (session.ungroupedTabs ?? []).length;
    session.metadata = { groupCount: (session.groups ?? []).length, tabCount };
    session.updated = Date.now();
    await chrome.storage.local.set({ sessions });
    return sessions[sessionId];
  },

  async removeGroupFromSession(sessionId, groupId) {
    const sessions = await this.getSessions();
    const session = sessions[sessionId];
    if (!session) throw new Error('Session not found');
    session.groups = (session.groups ?? []).filter(g => g.id !== groupId);
    const tabCount = session.groups.reduce((n, g) => n + g.tabs.length, 0) +
                     (session.ungroupedTabs ?? []).length;
    session.metadata = { groupCount: session.groups.length, tabCount };
    session.updated = Date.now();
    await chrome.storage.local.set({ sessions });
    return sessions[sessionId];
  },

  async addTabToSession(sessionId, tabData) {
    const sessions = await this.getSessions();
    const session = sessions[sessionId];
    if (!session) throw new Error('Session not found');
    session.ungroupedTabs = session.ungroupedTabs ?? [];
    session.ungroupedTabs.push(tabData);
    session.metadata = {
      ...session.metadata,
      tabCount: (session.metadata?.tabCount ?? 0) + 1
    };
    session.updated = Date.now();
    await chrome.storage.local.set({ sessions });
    return sessions[sessionId];
  },

  // ─── Settings ──────────────────────────────────────────────────────────────

  async getSettings() {
    const r = await chrome.storage.local.get('settings');
    return r.settings ?? { theme: 'dark' };
  },

  async saveSettings(settings) {
    await chrome.storage.local.set({ settings });
  },

  // ─── Quota (#12) ───────────────────────────────────────────────────────────

  // Returns usage as an integer percentage (0–100+).
  // Returns 0 when unlimitedStorage is granted (quota is undefined).
  async getUsagePercent() {
    const quota = chrome.storage.local.QUOTA_BYTES;
    if (!quota) return 0; // unlimitedStorage granted — no cap
    const used = await chrome.storage.local.getBytesInUse(null);
    return Math.round((used / quota) * 100);
  },

  // ─── Export / Import ───────────────────────────────────────────────────────

  async exportAll() {
    const r = await chrome.storage.local.get(null);
    return JSON.stringify({ _tabvault: true, version: 1, ...r }, null, 2);
  },

  async importAll(jsonString) {
    const data = JSON.parse(jsonString);
    if (!data._tabvault) throw new Error('Not a valid TabVault export file');
    const { _tabvault, version, ...rest } = data;
    await chrome.storage.local.set(rest);
    this._cache = rest.sessions ?? {}; // keep cache in sync after full overwrite
    return rest;
  },

  async exportSession(id) {
    const session = await this.getSession(id);
    if (!session) throw new Error('Session not found');
    return JSON.stringify({ _tabvault: true, version: 1, session }, null, 2);
  },

  exportAsMarkdown(session) {
    const lines = [`# ${session.name}`, ``, `> Saved: ${new Date(session.created).toLocaleString()}`, ``];
    for (const group of (session.groups ?? [])) {
      lines.push(`## ${group.name || 'Untitled Group'}`);
      if (group.tags?.length) lines.push(`*Tags: ${group.tags.join(', ')}*`);
      if (group.note) lines.push(`> ${group.note}`);
      lines.push('');
      for (const tab of (group.tabs ?? [])) {
        lines.push(`- [${tab.title || tab.url}](${tab.url})`);
        if (tab.note) lines.push(`  > ${tab.note}`);
      }
      lines.push('');
    }
    if (session.ungroupedTabs?.length) {
      lines.push(`## Ungrouped`);
      for (const tab of session.ungroupedTabs) {
        lines.push(`- [${tab.title || tab.url}](${tab.url})`);
      }
    }
    return lines.join('\n');
  }
};
