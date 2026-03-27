// shared/storage.js — Central persistence layer for TabVault
// Schema:
//   chrome.storage.local = {
//     sessions: { [id]: Session },
//     trash:    { [id]: Session & { deletedAt: number } },
//     versions: { [sessionId]: Snapshot[] },
//     settings: Settings
//   }
//
// Session = {
//   id, name, created, updated, autoSaved?, pinned?,
//   groups: Group[],
//   ungroupedTabs: Tab[],
//   metadata: { groupCount, tabCount }
// }
// Group = { id, name, color, tags, note, tabs: Tab[] }
// Tab   = { id, url, title, favicon, note, tags, savedAt }
// Snapshot = { snapshot: Session, savedAt: number }
// Settings = { theme, sortBy, autoSaveMinutes, syncEnabled }

export const StorageManager = {
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

  invalidate() {
    this._cache = null;
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
    const session = sessions[id];
    if (!session) return;
    delete sessions[id];
    const r = await chrome.storage.local.get('trash');
    const trash = r.trash ?? {};
    trash[id] = { ...session, deletedAt: Date.now() };
    await chrome.storage.local.set({ sessions, trash });
  },

  // ─── Pin / Favorite ────────────────────────────────────────────────────────

  async togglePin(id) {
    const sessions = await this.getSessions();
    if (!sessions[id]) return false;
    sessions[id].pinned = !sessions[id].pinned;
    sessions[id].updated = Date.now();
    await chrome.storage.local.set({ sessions });
    return sessions[id].pinned;
  },

  // ─── Merge Sessions ────────────────────────────────────────────────────────

  async mergeSessions(sourceIds, newName) {
    const sessions = await this.getSessions();
    const allGroups = [];
    const allUngrouped = [];

    for (const id of sourceIds) {
      const s = sessions[id];
      if (!s) continue;
      for (const g of (s.groups ?? [])) {
        allGroups.push({ ...g, id: this.generateId() });
      }
      for (const t of (s.ungroupedTabs ?? [])) {
        allUngrouped.push({ ...t, id: this.generateId() });
      }
    }

    const merged = {
      id: this.generateId(),
      name: newName || 'Merged Session',
      created: Date.now(),
      updated: Date.now(),
      groups: allGroups,
      ungroupedTabs: allUngrouped,
      metadata: {
        groupCount: allGroups.length,
        tabCount: allGroups.reduce((n, g) => n + (g.tabs?.length ?? 0), 0) + allUngrouped.length
      }
    };

    sessions[merged.id] = merged;
    await chrome.storage.local.set({ sessions });
    return merged;
  },

  // ─── Session Versioning ────────────────────────────────────────────────────

  async saveVersion(sessionId) {
    const sessions = await this.getSessions();
    const session = sessions[sessionId];
    if (!session) return;

    const r = await chrome.storage.local.get('versions');
    const versions = r.versions ?? {};
    const list = versions[sessionId] ?? [];

    // Deep clone the session for the snapshot (strip internal fields + favicons to save storage)
    const { _score, _matchingTabs, ...clean } = session;
    const snapshot = structuredClone(clean);
    for (const g of (snapshot.groups ?? [])) {
      for (const t of (g.tabs ?? [])) { t.favicon = ''; }
    }
    for (const t of (snapshot.ungroupedTabs ?? [])) { t.favicon = ''; }
    list.unshift({ snapshot, savedAt: Date.now() });

    // Keep max 5 versions
    if (list.length > 5) list.length = 5;
    versions[sessionId] = list;
    await chrome.storage.local.set({ versions });
  },

  async getVersions(sessionId) {
    const r = await chrome.storage.local.get('versions');
    return (r.versions ?? {})[sessionId] ?? [];
  },

  async restoreVersion(sessionId, versionIndex) {
    const r = await chrome.storage.local.get('versions');
    const versions = r.versions ?? {};
    const list = versions[sessionId] ?? [];
    const entry = list[versionIndex];
    if (!entry) throw new Error('Version not found');

    // Save current as a version before restoring
    await this.saveVersion(sessionId);

    const sessions = await this.getSessions();
    sessions[sessionId] = { ...entry.snapshot, id: sessionId, updated: Date.now() };
    await chrome.storage.local.set({ sessions });
    return sessions[sessionId];
  },

  // ─── Reorder ───────────────────────────────────────────────────────────────

  async reorderTabs(sessionId, groupId, fromIndex, toIndex) {
    const sessions = await this.getSessions();
    const session = sessions[sessionId];
    if (!session) return;

    const tabs = groupId
      ? (session.groups?.find(g => g.id === groupId)?.tabs ?? [])
      : (session.ungroupedTabs ?? []);

    if (fromIndex < 0 || fromIndex >= tabs.length || toIndex < 0 || toIndex >= tabs.length) return;
    const [moved] = tabs.splice(fromIndex, 1);
    tabs.splice(toIndex, 0, moved);

    session.updated = Date.now();
    await chrome.storage.local.set({ sessions });
    return session;
  },

  async reorderGroups(sessionId, fromIndex, toIndex) {
    const sessions = await this.getSessions();
    const session = sessions[sessionId];
    if (!session?.groups) return;

    const groups = session.groups;
    if (fromIndex < 0 || fromIndex >= groups.length || toIndex < 0 || toIndex >= groups.length) return;
    const [moved] = groups.splice(fromIndex, 1);
    groups.splice(toIndex, 0, moved);

    session.updated = Date.now();
    await chrome.storage.local.set({ sessions });
    return session;
  },

  async moveTabToGroup(sessionId, tabId, fromGroupId, toGroupId) {
    const sessions = await this.getSessions();
    const session = sessions[sessionId];
    if (!session) return;

    // Find and remove tab from source
    let tab = null;
    if (fromGroupId) {
      const srcGroup = session.groups?.find(g => g.id === fromGroupId);
      if (srcGroup) {
        const idx = srcGroup.tabs.findIndex(t => t.id === tabId);
        if (idx !== -1) [tab] = srcGroup.tabs.splice(idx, 1);
        if (srcGroup.tabs.length === 0) {
          session.groups = session.groups.filter(g => g.id !== fromGroupId);
        }
      }
    } else {
      const idx = (session.ungroupedTabs ?? []).findIndex(t => t.id === tabId);
      if (idx !== -1) [tab] = session.ungroupedTabs.splice(idx, 1);
    }

    if (!tab) return;

    // Add to destination
    if (toGroupId) {
      const destGroup = session.groups?.find(g => g.id === toGroupId);
      if (destGroup) destGroup.tabs.push(tab);
    } else {
      session.ungroupedTabs = session.ungroupedTabs ?? [];
      session.ungroupedTabs.push(tab);
    }

    // Update metadata
    session.metadata = {
      groupCount: (session.groups ?? []).length,
      tabCount: (session.groups ?? []).reduce((n, g) => n + g.tabs.length, 0) + (session.ungroupedTabs ?? []).length
    };
    session.updated = Date.now();
    await chrome.storage.local.set({ sessions });
    return session;
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
    // Also clean up versions
    const v = await chrome.storage.local.get('versions');
    const versions = v.versions ?? {};
    if (versions[id]) {
      delete versions[id];
      await chrome.storage.local.set({ versions });
    }
  },

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

  // ─── Session editing ───────────────────────────────────────────────────────

  async removeTabFromSession(sessionId, groupId, tabId) {
    const sessions = await this.getSessions();
    const session = sessions[sessionId];
    if (!session) throw new Error('Session not found');
    if (groupId) {
      const group = session.groups?.find(g => g.id === groupId);
      if (group) group.tabs = group.tabs.filter(t => t.id !== tabId);
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
    return {
      theme: 'dark',
      sortBy: 'newest',
      autoSaveMinutes: 0,
      syncEnabled: false,
      ...(r.settings ?? {})
    };
  },

  async saveSettings(settings) {
    await chrome.storage.local.set({ settings });
    // If sync is enabled, also push settings to sync storage
    if (settings.syncEnabled) {
      try { await chrome.storage.sync.set({ settings }); } catch { /* sync may be unavailable */ }
    }
  },

  async loadSyncSettings() {
    try {
      const r = await chrome.storage.sync.get('settings');
      return r.settings ?? null;
    } catch { return null; }
  },

  // ─── Quota ─────────────────────────────────────────────────────────────────

  async getUsagePercent() {
    const quota = chrome.storage.local.QUOTA_BYTES;
    if (!quota) return 0;
    const used = await chrome.storage.local.getBytesInUse(null);
    return Math.round((used / quota) * 100);
  },

  // ─── Export / Import ───────────────────────────────────────────────────────

  async exportAll() {
    const r = await chrome.storage.local.get(null);
    return JSON.stringify({ _tabvault: true, version: 2, ...r }, null, 2);
  },

  async importAll(jsonString) {
    const data = JSON.parse(jsonString);
    if (!data._tabvault) throw new Error('Not a valid TabVault export file');
    const { _tabvault, version, ...rest } = data;
    await chrome.storage.local.set(rest);
    this._cache = rest.sessions ?? {};
    return rest;
  },

  async exportSession(id) {
    const session = await this.getSession(id);
    if (!session) throw new Error('Session not found');
    return JSON.stringify({ _tabvault: true, version: 2, session }, null, 2);
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
  },

  // ─── Bulk operations ───────────────────────────────────────────────────────

  async deleteSessions(ids) {
    const sessions = await this.getSessions();
    const r = await chrome.storage.local.get('trash');
    const trash = r.trash ?? {};
    for (const id of ids) {
      const session = sessions[id];
      if (!session) continue;
      delete sessions[id];
      trash[id] = { ...session, deletedAt: Date.now() };
    }
    await chrome.storage.local.set({ sessions, trash });
    return { sessions, trash };
  }
};
