// TabVault Service Worker (MV3)
// Minimal — all heavy logic lives in the popup context.
// Service worker handles: capturing + restoring sessions on demand.

import { StorageManager } from '../shared/storage.js';
import { VALID_COLORS } from '../shared/utils.js';

// ─── Context menu ─────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'save-session',
    title: 'Save session — TabVault',
    contexts: ['page', 'frame']
  });
  chrome.contextMenus.create({
    id: 'open-tabvault',
    title: 'Open TabVault',
    contexts: ['page', 'frame']
  });
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId === 'save-session') {
    const name = `Session — ${new Date().toLocaleDateString()}`;
    const result = await captureCurrentWindow(name);
    if (result.ok) {
      chrome.action.setBadgeText({ text: '✓' });
      chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
      setTimeout(() => chrome.action.setBadgeText({ text: '' }), 3000);
    }
  }
  // 'open-tabvault' opens the popup; handled natively by _execute_action shortcut
  // but context menu can't open popup directly — open side panel as fallback
  if (info.menuItemId === 'open-tabvault') {
    chrome.action.openPopup().catch(() => {
      // openPopup may fail in some Chrome versions; silently ignore
    });
  }
});

// ─── Auto-save cache (#4) ─────────────────────────────────────────────────────
// Tracks open windows and their tabs so we can auto-save on window close.
// Service workers are ephemeral; this cache is rebuilt on startup and kept
// in sync via tab events. Using an in-memory Map (not storage.session) for
// simplicity — the cache is rebuilt from chrome.windows.getAll on SW startup.
const windowTabCache = new Map();

async function initWindowCache() {
  try {
    const windows = await chrome.windows.getAll({ populate: true });
    for (const win of windows) {
      windowTabCache.set(win.id, win.tabs ?? []);
    }
  } catch { /* service worker may start without windows context */ }
}
initWindowCache();

chrome.tabs.onCreated.addListener(tab => {
  const arr = windowTabCache.get(tab.windowId) ?? [];
  arr.push(tab);
  windowTabCache.set(tab.windowId, arr);
});

chrome.tabs.onRemoved.addListener((tabId, info) => {
  if (info.isWindowClosing) return; // handled by windows.onRemoved
  const arr = windowTabCache.get(info.windowId) ?? [];
  windowTabCache.set(info.windowId, arr.filter(t => t.id !== tabId));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const arr = windowTabCache.get(tab.windowId);
  if (!arr) return;
  const idx = arr.findIndex(t => t.id === tabId);
  if (idx !== -1) arr[idx] = tab;
  else arr.push(tab);
});

// Auto-save when a window closes (#4)
chrome.windows.onRemoved.addListener(async windowId => {
  const tabs = windowTabCache.get(windowId) ?? [];
  windowTabCache.delete(windowId);

  const validTabs = tabs.filter(t =>
    t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://')
  );
  if (validTabs.length < 2) return;

  const dateStr = new Date().toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });

  const tabObjects = await Promise.all(validTabs.map(async tab => ({
    id: StorageManager.generateId(),
    url: tab.url,
    title: tab.title || tab.url,
    favicon: await faviconToDataUrl(tab.favIconUrl),
    note: '',
    tags: [],
    savedAt: Date.now()
  })));

  const session = {
    id: StorageManager.generateId(),
    name: `Auto: ${dateStr}`,
    created: Date.now(),
    updated: Date.now(),
    groups: [],
    ungroupedTabs: tabObjects,
    autoSaved: true,
    metadata: { groupCount: 0, tabCount: tabObjects.length }
  };

  await StorageManager.saveSession(session);

  chrome.action.setBadgeText({ text: 'AUTO' });
  chrome.action.setBadgeBackgroundColor({ color: '#4169E1' });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 5000);
});

// ─── Keyboard shortcuts (#3) ──────────────────────────────────────────────────
chrome.commands.onCommand.addListener(async command => {
  if (command === 'save-session') {
    const name = `Session — ${new Date().toLocaleDateString()}`;
    const result = await captureCurrentWindow(name);
    if (result.ok) {
      chrome.action.setBadgeText({ text: '✓' });
      chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
      setTimeout(() => chrome.action.setBadgeText({ text: '' }), 3000);
    }
  }
});

// ─── Message handler ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  switch (msg.type) {
    case 'CAPTURE_SESSION':
      captureCurrentWindow(msg.name).then(respond);
      return true;
    case 'RESTORE_SESSION':
      restoreSession(msg.sessionId, msg.windowId ?? null).then(respond);
      return true;
  }
});

// ─── Favicon helper (#2) ──────────────────────────────────────────────────────
// Converts a favicon URL to a data URL so it persists after the tab closes.
// Service workers have no canvas/Image; we use fetch + ArrayBuffer + btoa.
async function faviconToDataUrl(url) {
  if (!url) return '';
  if (url.startsWith('data:')) return url;
  if (url.startsWith('chrome://') || url.startsWith('chrome-extension://')) return '';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!resp.ok) return '';
    const buffer = await resp.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const type = resp.headers.get('content-type') || 'image/png';
    return `data:${type};base64,${btoa(binary)}`;
  } catch {
    return '';
  }
}

// ─── Capture ──────────────────────────────────────────────────────────────────
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

    // Fetch favicons in parallel (#2)
    const tabPromises = [];
    for (const tab of tabs) {
      if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) continue;
      tabPromises.push(
        faviconToDataUrl(tab.favIconUrl).then(favicon => ({ raw: tab, favicon }))
      );
    }
    const resolved = await Promise.all(tabPromises);

    const ungroupedTabs = [];
    for (const { raw: tab, favicon } of resolved) {
      const t = {
        id: StorageManager.generateId(),
        url: tab.url,
        title: tab.title || tab.url,
        favicon,
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

// ─── Restore ──────────────────────────────────────────────────────────────────
async function restoreSession(sessionId, targetWindowId = null) {
  try {
    const session = await StorageManager.getSession(sessionId);
    if (!session) return { ok: false, error: 'Session not found' };

    const ungrouped = (session.ungroupedTabs ?? []).filter(t => t.url && !t.url.startsWith('chrome://'));
    const groups = (session.groups ?? []).map(g => ({
      ...g,
      validTabs: (g.tabs ?? []).filter(t => t.url && !t.url.startsWith('chrome://'))
    })).filter(g => g.validTabs.length > 0);

    const allUrls = [...ungrouped.map(t => t.url), ...groups.flatMap(g => g.validTabs.map(t => t.url))];
    if (allUrls.length === 0) return { ok: false, error: 'No valid tabs to restore' };

    let winId;
    let firstConsumed;

    if (targetWindowId) {
      // feat #6: restore into existing window — no tab is pre-created
      winId = targetWindowId;
      firstConsumed = true;
    } else {
      // default: open a new window, first URL is consumed by window creation
      const newWin = await chrome.windows.create({ url: allUrls[0] });
      winId = newWin.id;
      firstConsumed = false;
    }

    // Create ungrouped tabs
    for (let i = 0; i < ungrouped.length; i++) {
      if (i === 0 && !firstConsumed) { firstConsumed = true; continue; }
      await chrome.tabs.create({ windowId: winId, url: ungrouped[i].url });
    }

    // Create grouped tabs
    for (const group of groups) {
      const tabIds = [];
      for (let i = 0; i < group.validTabs.length; i++) {
        if (!firstConsumed && i === 0 && ungrouped.length === 0) {
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
