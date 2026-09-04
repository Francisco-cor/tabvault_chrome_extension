// ui/actions/liveActions.js — Acciones sobre tabs/grupos VIVOS (Fase 7.6).
// Cerrar/pinear operan directo con chrome.tabs (la UI puede); stash va por
// mensaje al SW (single-writer del vault); guardar grupo como sesión también.

import { MSG, sendToBackground } from '../../shared/messages.js';
import { showToast } from './sessionActions.js';

/**
 * @param {any} ctx @param {HTMLElement} el botón con data-tab-id
 */
export async function closeLiveTab(ctx, el) {
  const tabId = Number(el.dataset.tabId);
  if (!Number.isFinite(tabId)) return;
  try {
    await chrome.tabs.remove(tabId);
    showToast(ctx, 'Tab closed');
  } catch {
    showToast(ctx, 'Could not close tab', 'error');
  }
}

/** @param {any} ctx @param {HTMLElement} el */
export async function pinLiveTab(ctx, el) {
  const tabId = Number(el.dataset.tabId);
  if (!Number.isFinite(tabId)) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    const pinned = !(/** @type {any} */ (tab).pinned === true);
    await chrome.tabs.update(tabId, { pinned });
    showToast(ctx, pinned ? 'Tab pinned' : 'Tab unpinned', 'success');
  } catch {
    showToast(ctx, 'Could not update tab', 'error');
  }
}

/** Stash de una tab viva por id (misma sesión especial del context menu). @param {any} ctx @param {HTMLElement} el */
export async function stashLiveTab(ctx, el) {
  const tabId = Number(el.dataset.tabId);
  if (!Number.isFinite(tabId)) return;
  const res = await sendToBackground({ type: MSG.STASH_TAB, tabId });
  if (res.ok) {
    const added = /** @type {any} */ (res).data?.added;
    showToast(ctx, added ? 'Stashed' : 'Already in Stash', 'success');
  } else {
    showToast(ctx, /** @type {any} */ (res).error ?? 'Stash failed', 'error');
  }
}

/**
 * Guarda un grupo vivo como sesión individual. groupId nativo; la ventana se
 * resuelve desde el selector activo de GroupsView (o la enfocada).
 * @param {any} ctx @param {number|null} activeWindowId
 * @param {string|undefined} groupIdStr
 * @param {string|undefined} name
 */
export async function saveGroupAsSession(ctx, activeWindowId, groupIdStr, name) {
  const nativeGroupId = Number(groupIdStr);
  let windowId = activeWindowId;
  if (!Number.isFinite(nativeGroupId)) return;
  if (windowId == null) {
    try {
      windowId = /** @type {number} */ ((await chrome.windows.getCurrent()).id);
    } catch {
      return showToast(ctx, 'No window to capture from', 'error');
    }
  }
  showToast(ctx, 'Saving group…');
  const res = await sendToBackground({
    type: MSG.SAVE_GROUP_AS_SESSION,
    windowId,
    groupId: nativeGroupId,
    ...(name ? { name } : {}),
  });
  if (res.ok) {
    const savedName = /** @type {any} */ (res).data?.name ?? 'Group session';
    showToast(ctx, `"${savedName}" saved`, 'success');
  } else {
    showToast(ctx, /** @type {any} */ (res).error ?? 'Save failed', 'error');
  }
}
