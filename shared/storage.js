// shared/storage.js — Central persistence layer for TabVault
// Schema:
//   chrome.storage.local = {
//     sessions: { [id]: Session },
//     settings: Settings
//   }
//
// Session = {
//   id, name, created, updated,
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
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
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

  async deleteSession(id) {
    const sessions = await this.getSessions();
    delete sessions[id];
    await chrome.storage.local.set({ sessions });
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

  // chrome.storage.local has a ~10 MB limit without the unlimitedStorage permission.
  // Returns usage as an integer percentage (0–100+).
  async getUsagePercent() {
    const QUOTA_BYTES = 10 * 1024 * 1024; // 10 MB
    const used = await chrome.storage.local.getBytesInUse(null);
    return Math.round((used / QUOTA_BYTES) * 100);
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
