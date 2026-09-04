// background/sw-main.js — Punto de entrada del service worker (MV3).
// SOLO registra listeners y arranca ciclo de vida; la lógica vive en handlers/*.
// El SW no tiene memoria: el estado durable vive en storage.local/session.

import { repository as repo } from '../core/repository.js';
import { MSG } from '../shared/messages.js';
import { createLogger } from '../shared/logger.js';
import { handleMessage } from './handlers/messages.js';
import {
  onWindowRemoved,
  runPeriodicAutoSave,
  scheduleWindowSnapshot,
  snapshotAllWindows,
} from './handlers/autosave.js';
import {
  flashBadge,
  handleBadgeAlarm,
  handleGlobalCommand,
  openVaultUi,
  registerContextMenus,
} from './handlers/lifecycle.js';
import {
  scheduleAllRoutines,
  handleRoutineAlarm,
  handleRoutineNotificationClick,
} from './handlers/routines.js';

const AUTOSAVE_ALARM = 'tabvault-autosave';
const TRASH_PURGE_ALARM = 'tabvault-trash-purge';
const BACKUP_ALARM = 'tabvault-backups';
const DAY_MINUTES = 60 * 24;
const logger = createLogger('sw');

// Coherencia multi-contexto: suscripción a onChanged (fix C2).
repo.attach();

// ─── Boot ─────────────────────────────────────────────────────────────────────
boot();
async function boot() {
  logger.info('boot', 'service worker started');
  try {
    const res = await repo.runMigrations((m) => logger.info('migrate', m));
    if (res.migrated) logger.info('migrate', `esquema migrado v${res.from} → v${res.to}`);
  } catch (e) {
    logger.error('migrate', `migration failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  // Fix C1 (parte preventiva): snapshot inicial de ventanas a storage.session.
  snapshotAllWindows();
  void scheduleAllRoutines();
}

chrome.runtime.onInstalled.addListener(() => {
  registerContextMenus(); // M1: removeAll → creates dentro del callback
  initAutoSaveAlarm();
  scheduleTrashPurgeAlarm();
  scheduleBackupAlarm();
  void scheduleAllRoutines();
});

chrome.runtime.onStartup.addListener(() => {
  boot();
  scheduleTrashPurgeAlarm();
  scheduleBackupAlarm();
  void scheduleAllRoutines();
});

// ─── Context menus (ids namespaced, M1) ───────────────────────────────────────
chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId === 'tabvault_save_session') {
    const result = await handleMessage({ type: MSG.CAPTURE_SESSION, name: sessionNameForToday() });
    if (result.ok) await flashBadge('✓', '#22c55e');
  }
  if (info.menuItemId === 'tabvault_stash_page') {
    // Fase 6.1: stash de ESA tab (optimista: badge persistente, sin abrir UI).
    const result = await handleMessage({ type: MSG.STASH_TAB, tabId: /** @type {any} */ (info).tabId });
    if (!result.ok) console.warn('[TabVault] stash failed:', result.error);
  }
  if (info.menuItemId === 'tabvault_open_popup') {
    openVaultUi(); // M2: fallback automático en Chrome < 127
  }
});

// ─── Keyboard shortcuts ───────────────────────────────────────────────────────
chrome.commands.onCommand.addListener(async (command) => {
  // Fase 7.2: quick-switcher / quick-search / toggle-theme (+3 en manifest).
  if (await handleGlobalCommand(command, { repo })) return;
  if (command === 'save-session') {
    const result = await handleMessage({ type: MSG.CAPTURE_SESSION, name: sessionNameForToday() });
    if (result.ok) await flashBadge('✓', '#22c55e');
  }
  if (command === 'stash-tab') {
    const result = await handleMessage({ type: MSG.STASH_TAB }); // tab activa
    if (!result.ok) console.warn('[TabVault] stash failed:', result.error);
  }
});

// ─── Alarms ───────────────────────────────────────────────────────────────────
async function initAutoSaveAlarm() {
  try {
    const settings = await repo.getSettings();
    const minutes = settings.autoSaveMinutes ?? 0;
    await chrome.alarms.clear(AUTOSAVE_ALARM);
    if (minutes > 0) {
      chrome.alarms.create(AUTOSAVE_ALARM, { periodInMinutes: minutes });
    }
  } catch (e) {
    console.error('[TabVault] initAutoSaveAlarm failed:', e);
  }
}

/** Purga diaria de papelera según settings.trashPurgeDays (fix C10). */
async function scheduleTrashPurgeAlarm() {
  try {
    await chrome.alarms.clear(TRASH_PURGE_ALARM);
    chrome.alarms.create(TRASH_PURGE_ALARM, { periodInMinutes: DAY_MINUTES });
  } catch (e) {
    console.error('[TabVault] scheduleTrashPurgeAlarm failed:', e);
  }
}

/** Snapshot diario al ring-buffer de backups (Fase 8.3). */
function scheduleBackupAlarm() {
  try {
    chrome.alarms.create(BACKUP_ALARM, { periodInMinutes: DAY_MINUTES });
  } catch (e) {
    console.error('[TabVault] scheduleBackupAlarm failed:', e);
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (await handleBadgeAlarm(alarm)) return; // M5: limpieza sin setTimeout
  if (await handleRoutineAlarm(alarm)) return;
  if (alarm.name === TRASH_PURGE_ALARM) {
    try {
      const removed = await repo.purgeOldTrash();
      if (removed) console.log('[TabVault] papelera purgada');
    } catch (e) {
      console.error('[TabVault] trash purge failed:', e);
    }
    return;
  }
  if (alarm.name === BACKUP_ALARM) {
    try {
      const entry = await repo.createBackup('daily');
      if (entry) console.log('[TabVault] backup diario creado');
    } catch (e) {
      console.error('[TabVault] daily backup failed:', e);
    }
    return;
  }
  if (alarm.name !== AUTOSAVE_ALARM) return;
  try {
    const saved = await runPeriodicAutoSave();
    if (saved > 0) await flashBadge('AUTO', '#4169E1');
  } catch (e) {
    console.error('[TabVault] Periodic auto-save failed:', e);
  }
});

// ─── Settings → reprogramar alarms ────────────────────────────────────────────
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.settings) {
    const next = /** @type {any} */ (changes.settings.newValue ?? {});
    const prev = /** @type {any} */ (changes.settings.oldValue ?? {});
    if ((next.autoSaveMinutes ?? 0) !== (prev.autoSaveMinutes ?? 0)) initAutoSaveAlarm();
    if ((next.trashPurgeDays ?? 30) !== (prev.trashPurgeDays ?? 30)) scheduleTrashPurgeAlarm();
  }
  if ('routines' in changes) void scheduleAllRoutines();
});

// ─── Notificaciones de rutina (Fase 9.4) ─────────────────────────────────────
if (chrome.notifications?.onClicked) {
  chrome.notifications.onClicked.addListener((id) => void handleRoutineNotificationClick(id, 0));
}
if (chrome.notifications?.onButtonClicked) {
  chrome.notifications.onButtonClicked.addListener((id, idx) => void handleRoutineNotificationClick(id, idx));
}

// ─── Snapshots de ventanas → storage.session (fix C1) ─────────────────────────
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.windowId != null) scheduleWindowSnapshot(tab.windowId);
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.windowId != null) scheduleWindowSnapshot(tab.windowId);
});
chrome.tabs.onMoved.addListener((tabId, info) => {
  scheduleWindowSnapshot(info.windowId);
});
chrome.tabs.onRemoved.addListener((_tabId, info) => {
  // isWindowClosing: la ventana entera se está cerrando → lo maneja onRemoved.
  if (!info.isWindowClosing && info.windowId != null) scheduleWindowSnapshot(info.windowId);
});
chrome.windows.onCreated.addListener((win) => {
  if (win.id != null) scheduleWindowSnapshot(win.id);
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  try {
    const saved = await onWindowRemoved(windowId);
    if (saved) await flashBadge('AUTO', '#4169E1', 5000);
  } catch (e) {
    console.error('[TabVault] auto-save on window close failed:', e);
  }
});

// ─── Mensajería formal (task 3.5) ────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  handleMessage(/** @type {any} */ (msg))
    .then(respond)
    .catch((e) => {
      console.error('[TabVault] message handler crashed:', e);
      respond({ ok: false, error: 'Internal handler error' });
    });
  return true; // canal async abierto
});

function sessionNameForToday() {
  return `Session — ${new Date().toLocaleDateString()}`;
}
