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
  generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
  },

  // ─── Sessions ──────────────────────────────────────────────────────────────

  async getSessions() {
    const r = await chrome.storage.local.get('sessions');
    return r.sessions ?? {};
  },

  async getSession(id) {
    const sessions = await this.getSessions();
    return sessions[id] ?? null;
  },

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
