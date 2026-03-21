// TabVault Service Worker (MV3)
// Minimal — all heavy logic lives in the popup context.
// Service worker handles: capturing + restoring sessions on demand.

import { StorageManager } from '../shared/storage.js';
import { VALID_COLORS } from '../shared/utils.js';

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  switch (msg.type) {
    case 'CAPTURE_SESSION':
      captureCurrentWindow(msg.name).then(respond);
      return true;
    case 'RESTORE_SESSION':
      restoreSession(msg.sessionId).then(respond);
      return true;
  }
});

async function captureCurrentWindow(name) {
  try {
    const win = await chrome.windows.getCurrent();
    const [tabs, groups] = await Promise.all([
      chrome.tabs.query({ windowId: win.id }),
      chrome.tabGroups.query({ windowId: win.id })
    ]);

    const groupMap = new Map();
    for (const g of groups) {
      groupMap.set(g.id, {
        id: StorageManager.generateId(),
        name: g.title || 'Untitled Group',
        color: g.color,
        tags: [],
        note: '',
        tabs: []
      });
    }

    const ungroupedTabs = [];
    for (const tab of tabs) {
      if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) continue;
      const t = {
        id: StorageManager.generateId(),
        url: tab.url,
        title: tab.title || tab.url,
        favicon: tab.favIconUrl || '',
        note: '',
        tags: [],
        savedAt: Date.now()
      };
      if (tab.groupId > 0 && groupMap.has(tab.groupId)) {
        groupMap.get(tab.groupId).tabs.push(t);
      } else {
        ungroupedTabs.push(t);
      }
    }

    const sessionGroups = [...groupMap.values()].filter(g => g.tabs.length > 0);
    const tabCount = sessionGroups.reduce((s, g) => s + g.tabs.length, 0) + ungroupedTabs.length;

    const session = {
      id: StorageManager.generateId(),
      name: name || `Session — ${new Date().toLocaleDateString()}`,
      created: Date.now(),
      updated: Date.now(),
      groups: sessionGroups,
      ungroupedTabs,
      metadata: { groupCount: sessionGroups.length, tabCount }
    };

    await StorageManager.saveSession(session);
    return { ok: true, session };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function restoreSession(sessionId) {
  try {
    const session = await StorageManager.getSession(sessionId);
    if (!session) return { ok: false, error: 'Session not found' };

    const allUrls = [
      ...(session.ungroupedTabs ?? []),
      ...(session.groups ?? []).flatMap(g => g.tabs ?? [])
    ].map(t => t.url).filter(u => u && !u.startsWith('chrome://'));

    if (allUrls.length === 0) return { ok: false, error: 'No valid tabs to restore' };

    // Open new window with first URL
    const newWin = await chrome.windows.create({ url: allUrls[0] });
    const winId = newWin.id;

    const ungrouped = (session.ungroupedTabs ?? []).filter(t => t.url && !t.url.startsWith('chrome://'));
    const groups = (session.groups ?? []).map(g => ({
      ...g,
      validTabs: (g.tabs ?? []).filter(t => t.url && !t.url.startsWith('chrome://'))
    })).filter(g => g.validTabs.length > 0);

    // Track whether first tab is consumed
    let firstConsumed = false;

    // Create ungrouped tabs (first URL already used for window creation)
    for (let i = 0; i < ungrouped.length; i++) {
      if (i === 0) { firstConsumed = true; continue; } // skip — already the window's first tab
      await chrome.tabs.create({ windowId: winId, url: ungrouped[i].url });
    }

    // Create grouped tabs
    for (const group of groups) {
      const tabIds = [];
      for (let i = 0; i < group.validTabs.length; i++) {
        if (!firstConsumed && i === 0 && ungrouped.length === 0) {
          // Use the initial tab created with the window
          const winTabs = await chrome.tabs.query({ windowId: winId });
          tabIds.push(winTabs[0].id);
          firstConsumed = true;
        } else {
          const t = await chrome.tabs.create({ windowId: winId, url: group.validTabs[i].url });
          tabIds.push(t.id);
        }
      }
      const gId = await chrome.tabs.group({ tabIds, createProperties: { windowId: winId } });
      await chrome.tabGroups.update(gId, {
        title: group.name || '',
        color: VALID_COLORS.includes(group.color) ? group.color : 'purple'
      });
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
