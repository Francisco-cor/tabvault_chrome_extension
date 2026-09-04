// ui/actions/sessionActions.js — Acciones sobre sesiones: restaurar (new/append/
// replace/incógnito/portapapeles/parcial), borrar+undo, pin, renombrar, tags,
// versiones, plantillas (6.3) y el flujo de guardado selectivo con detección de
// duplicados v2 (6.1/6.4).

import { A } from '../actions.js';
import { MSG, sendToBackground } from '../../shared/messages.js';
import { findDuplicateOf, suggestSessionName, fallbackSessionName } from '../../core/domain.js';
import { isValidTabUrl } from '../../shared/urlRules.js';
import { formatRelativeTime } from '../../shared/utils.js';
import { showMenu } from '../components/ContextMenu.js';
import { closeModal, openModal } from '../components/Modal.js';
import { Icon } from '../components/Icon.js';
import { favIconHtml } from '../components/Favicon.js';

/**
 * Toast corto sobre el elemento persistente #toast.
 * @param {any} ctx @param {string} msg @param {''|'success'|'error'} [type]
 */
export function showToast(ctx, msg, type = '') {
  const el = ctx.dom.toast;
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast' + (type ? ' ' + type : '');
  el.removeAttribute('hidden');
  clearTimeout(ctx._toastTimer);
  ctx._toastTimer = setTimeout(() => el.setAttribute('hidden', ''), 2500);
}

/** @param {any} ctx @param {string} id */
export async function togglePin(ctx, id) {
  const pinned = await ctx.repo.togglePin(id);
  ctx.store.dispatch({ type: A.PINNED, id, pinned });
  showToast(ctx, pinned ? 'Pinned' : 'Unpinned', 'success');
}

/** @param {any} ctx @param {string} id */
export function openDetail(ctx, id) {
  ctx.router.push('detail', { detailSessionId: id });
}

/** @param {any} ctx @param {string} sessionId */
export async function loadVersions(ctx, sessionId) {
  const versions = await ctx.repo.getVersions(sessionId);
  ctx.store.dispatch({ type: A.VERSIONS_LOADED, sessionId, versions });
}

// ─── Restauración ─────────────────────────────────────────────────────────────

/** @param {any} ctx @param {string} id */
export async function restoreNewWindow(ctx, id) {
  const session = ctx.store.getState().sessions[id];
  if (!session) return;
  showToast(ctx, `Restoring "${session.name}"…`);
  const res = await sendToBackground({ type: MSG.RESTORE_SESSION, sessionId: id });
  if (res.ok) showToast(ctx, `Opened ${session.metadata?.tabCount ?? 0} tabs`, 'success');
  else showToast(ctx, res.error ?? 'Restore failed', 'error');
}

/** @param {any} ctx @param {string} id @param {number|null} [windowId] */
export async function restoreInWindow(ctx, id, windowId = null) {
  let wid = windowId ?? null;
  if (wid == null) {
    try {
      wid = /** @type {number} */ ((await chrome.windows.getCurrent()).id);
    } catch {
      wid = null;
    }
  }
  const res = await sendToBackground({ type: MSG.RESTORE_SESSION, sessionId: id, windowId: wid });
  if (res.ok) showToast(ctx, 'Tabs added to this window', 'success');
  else showToast(ctx, res.error ?? 'Restore failed', 'error');
}

/** @param {any} ctx @param {string} id */
export async function replaceWindow(ctx, id) {
  const session = ctx.store.getState().sessions[id];
  if (!session) return;
  let winId = null;
  try {
    winId = /** @type {number} */ ((await chrome.windows.getCurrent()).id);
  } catch {
    /* sin ventana activa: el SW usará lastFocused */
  }
  showToast(ctx, `Replacing window with "${session.name}"…`);
  const res = await sendToBackground({
    type: MSG.REPLACE_WINDOW_WITH_SESSION,
    sessionId: id,
    windowId: winId,
  });
  if (res.ok) {
    const opened = /** @type {any} */ (res).data?.opened ?? session.metadata?.tabCount ?? 0;
    showToast(ctx, `Window replaced — ${opened} tabs`, 'success');
  } else {
    showToast(ctx, res.error ?? 'Replace failed', 'error');
  }
}

/**
 * ¿Puede el navegador abrir tabs de la extensión en incógnito?
 * @returns {Promise<boolean>}
 */
function allowedIncognito() {
  return new Promise((resolve) => {
    try {
      chrome.extension.isAllowedIncognitoAccess((allowed) => {
        void chrome.runtime.lastError;
        resolve(allowed === true);
      });
    } catch {
      resolve(false);
    }
  });
}

/** Menú de opciones de restauración (Fase 6.2: + incógnito y copiar URLs).
 * @param {any} ctx @param {HTMLElement} anchor @param {string} id */
export function showRestoreMenu(ctx, anchor, id) {
  showMenu(anchor, [
    { label: 'New window', icon: Icon('window', 11), action: () => void restoreNewWindow(ctx, id) },
    { label: 'This window', icon: Icon('play', 11), action: () => void restoreInWindow(ctx, id) },
    { label: 'Replace this window', icon: Icon('replace', 11), action: () => void replaceWindow(ctx, id) },
    {
      label: 'New incognito window',
      icon: Icon('eyeOff', 11),
      action: async () => {
        if (!(await allowedIncognito())) {
          showToast(ctx, 'Enable TabVault in Incognito first (chrome://extensions)', 'error');
          return;
        }
        await sendToBackground({ type: MSG.RESTORE_SESSION, sessionId: id, mode: 'incognito' });
        showToast(ctx, 'Opened in incognito', 'success');
      },
    },
    { divider: true, label: '', action: () => {} },
    { label: 'Copy URL list', icon: Icon('copy', 11), action: () => void copySessionUrls(ctx, id) },
  ]);
}

/** Copia todas las URLs de la sesión al portapapeles, una por línea.
 * @param {any} ctx @param {string} id */
export async function copySessionUrls(ctx, id) {
  const session = ctx.store.getState().sessions[id];
  const urls = sessionUrls(session);
  if (urls.length === 0) return showToast(ctx, 'No URLs to copy', 'error');
  try {
    await navigator.clipboard.writeText(urls.join('\n'));
    showToast(ctx, `${urls.length} URLs copied`, 'success');
  } catch {
    showToast(ctx, 'Clipboard unavailable', 'error');
  }
}

/** Todas las URLs válidas de una sesión en orden estable. @param {any} session @returns {string[]} */
export function sessionUrls(session) {
  if (!session) return [];
  return [
    ...(session.ungroupedTabs ?? []).map((/** @type {any} */ t) => t.url),
    ...(session.groups ?? []).flatMap((/** @type {any} */ g) =>
      (g.tabs ?? []).map((/** @type {any} */ t) => t.url)
    ),
  ].filter((u) => isValidTabUrl(u));
}

// ─── Plantillas (Fase 6.3) ───────────────────────────────────────────────────

/** Marca/desmarca una sesión como plantilla. @param {any} ctx @param {string} id */
export async function toggleTemplate(ctx, id) {
  const current = !!ctx.store.getState().sessions[id]?.isTemplate;
  await ctx.repo.updateSession(id, { isTemplate: !current });
  showToast(ctx, !current ? 'Marked as template' : 'Template removed', 'success');
}

// ─── Restauración parcial (Fase 6.2) ─────────────────────────────────────────

/** Ids incluidos = todos los de la sesión menos los desmarcados del store.
 * @param {any} session @param {string[]} unchecked @returns {string[]|undefined} */
export function includedTabIds(session, unchecked) {
  if (!session) return undefined;
  const all = [
    ...(session.ungroupedTabs ?? []),
    ...(session.groups ?? []).flatMap((/** @type {any} */ g) => g.tabs ?? []),
  ].map((t) => t.id);
  if (unchecked.length === 0 || unchecked.length >= all.length) return all; // vacío o nada seleccionado → todo
  return all.filter((id) => !unchecked.includes(id));
}

/** Abre solo las tabs marcadas del detalle. @param {any} ctx */
export async function openSelectedTabs(ctx) {
  const state = ctx.store.getState();
  const session = state.sessions[state.detailSessionId ?? ''];
  if (!session) return;
  const tabIds = includedTabIds(session, state.detailUnchecked);
  if (!tabIds?.length) return showToast(ctx, 'Nothing selected to open', 'error');
  showToast(ctx, `Opening ${tabIds.length} tab${tabIds.length !== 1 ? 's' : ''}…`);
  const res = await sendToBackground({
    type: MSG.RESTORE_SESSION,
    sessionId: session.id,
    tabIds,
  });
  if (res.ok)
    showToast(ctx, `Opened ${/** @type {any} */ (res).data?.opened ?? tabIds.length} tabs`, 'success');
  else showToast(ctx, res.error ?? 'Restore failed', 'error');
}

// ─── Borrado con undo ─────────────────────────────────────────────────────────

/** @param {any} ctx @param {string} id */
export async function deleteSoft(ctx, id) {
  const state = ctx.store.getState();
  const session = state.sessions[id];
  if (!session) return;

  // Animación de salida; el borrado real lo hace el SW (single-writer) y la UI
  // se refresca sola por onChanged → SESSIONS_SYNCED.
  const card = document.querySelector(`.session-card[data-id="${attrEscape(id)}"]`);
  if (card instanceof HTMLElement) {
    card.style.transition = 'opacity 0.2s, transform 0.2s';
    card.style.opacity = '0';
    card.style.transform = 'translateX(8px)';
  }

  await ctx.repo.deleteSession(id);

  ctx.undoToast.show(`"${session.name}" deleted`, async () => {
    const restored = await ctx.repo.restoreFromTrash(id);
    showToast(ctx, `"${restored.name}" restored`, 'success');
  });
}

// ─── Renombrado inline ────────────────────────────────────────────────────────

/** @param {any} ctx @param {HTMLElement} el @param {string} id */
export function startRename(ctx, el, id) {
  if (el.getAttribute('contenteditable') === 'true') return;
  el.setAttribute('contenteditable', 'true');
  el.classList.add('editing');
  el.focus();

  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);

  const controller = new AbortController();
  /** @param {boolean} save */
  const finish = async (save) => {
    controller.abort();
    el.removeAttribute('contenteditable');
    el.classList.remove('editing');
    const current = ctx.store.getState().sessions[id]?.name;
    if (!save) {
      el.textContent = current ?? '';
      return;
    }
    const newName = (el.textContent ?? '').trim() || current;
    if (newName && newName !== current) {
      await ctx.repo.updateSession(id, { name: newName });
      showToast(ctx, 'Renamed', 'success');
    }
  };

  el.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void finish(true);
      }
      if (e.key === 'Escape') void finish(false);
    },
    { signal: controller.signal }
  );
  el.addEventListener('blur', () => void finish(true), { once: true });
}

// ─── Tags / tabs / grupos del detalle ─────────────────────────────────────────

// ─── Tags de nivel sesión y de tab (Fase 7.3) ────────────────────────────────

/**
 * Añade una tag al nivel SESIÓN (sin duplicar, case-insensitive).
 * @param {any} ctx @param {string} sessionId @param {string} raw
 */
export async function addSessionTag(ctx, sessionId, raw) {
  const value = String(raw ?? '').trim();
  if (!value) return;
  const session = ctx.store.getState().sessions[sessionId];
  if (!session) return;
  const current = session.tags ?? [];
  if (current.some((/** @type {string} */ t) => t.toLowerCase() === value.toLowerCase())) {
    return showToast(ctx, 'Tag already on this session', 'error');
  }
  await ctx.repo.setSessionTags(sessionId, [...current, value]);
}

/** @param {any} ctx @param {string} sessionId @param {number} tagIndex */
export async function removeSessionTag(ctx, sessionId, tagIndex) {
  const session = ctx.store.getState().sessions[sessionId];
  if (!session) return;
  const next = (session.tags ?? []).filter(
    (/** @type {string} */ _v, /** @type {number} */ i) => i !== tagIndex
  );
  await ctx.repo.setSessionTags(sessionId, next);
}

/**
 * Localiza una tab del detalle (grupo o ungrouped). Pura.
 * @param {any} session @param {string|null} groupId @param {string} tabId
 */
function findTabInSession(session, groupId, tabId) {
  const list = groupId
    ? (session?.groups ?? []).find((/** @type {any} */ g) => g.id === groupId)?.tabs
    : session?.ungroupedTabs;
  return list?.find((/** @type {any} */ t) => t.id === tabId);
}

/**
 * Añade una tag a UNA tab del detalle (grupo o ungrouped). @param {any} ctx
 * @param {string} sessionId @param {string|null} groupId @param {string} tabId @param {string} raw
 */
export async function addTabTag(ctx, sessionId, groupId, tabId, raw) {
  const value = String(raw ?? '').trim();
  if (!value) return;
  const session = ctx.store.getState().sessions[sessionId];
  const tab = findTabInSession(session, groupId, tabId);
  if (!tab) return;
  const current = tab.tags ?? [];
  if (current.some((/** @type {string} */ t) => t.toLowerCase() === value.toLowerCase())) {
    return showToast(ctx, 'Tag already on this tab', 'error');
  }
  await ctx.repo.setTabTags(sessionId, groupId || null, tabId, [...current, value]);
}

/**
 * Editor inline de tag de tab: reemplaza el botón "+" por un input con
 * autocomplete; Enter/blur confirma. Mismo patrón que startAddGroupTag.
 * @param {any} ctx @param {HTMLButtonElement} btn
 */
export function startAddTabTag(ctx, btn) {
  const sessionId = /** @type {string} */ (btn.dataset.sessionId);
  const groupId = btn.dataset.groupId || null;
  const tabId = /** @type {string} */ (btn.dataset.tabId);

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'tag-input';
  input.placeholder = 'tag…';
  input.maxLength = 40;
  input.setAttribute('list', 'tv-tag-options'); // datalist del render del detalle
  input.dataset.fk = `tabtag:${sessionId}:${groupId ?? ''}:${tabId}`;
  btn.replaceWith(input);
  input.focus();

  const commit = async () => {
    const val = input.value.trim();
    input.remove();
    if (val && ctx.renderer) {
      await addTabTag(ctx, sessionId, groupId, tabId, val);
      // El sync por onChanged re-pinta; invalidate acelera feedback local.
      ctx.renderer.invalidate();
      ctx.renderer.render();
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void commit();
    } else if (e.key === 'Escape') {
      input.remove();
    }
  });
  input.addEventListener('blur', () => void commit(), { once: true });
}

/** @param {any} ctx @param {string} sessionId @param {string|null} groupId @param {string} tabId @param {number} tagIndex */
export async function removeTabTag(ctx, sessionId, groupId, tabId, tagIndex) {
  const state = ctx.store.getState();
  const session = state.sessions[sessionId];
  if (!session) return;
  const tab = findTabInSession(session, groupId, tabId);
  if (!tab) return;
  const next = (tab.tags ?? []).filter((/** @type {string} */ _v, /** @type {number} */ i) => i !== tagIndex);
  await ctx.repo.setTabTags(sessionId, groupId || null, tabId, next);
}

/** @param {any} ctx @param {string} sessionId @param {string} groupId @param {number} tagIndex */
export async function removeGroupTag(ctx, sessionId, groupId, tagIndex) {
  const session = ctx.store.getState().sessions[sessionId];
  if (!session) return;
  const group = session.groups?.find((/** @type {any} */ g) => g.id === groupId);
  if (!group) return;
  group.tags = (group.tags ?? []).filter((/** @type {any} */ _v, /** @type {number} */ i) => i !== tagIndex);
  await ctx.repo.updateSession(sessionId, { groups: session.groups });
}

/** Añade una tag inline reemplazando el botón "+ tag". @param {any} ctx @param {HTMLButtonElement} btn */
export function startAddGroupTag(ctx, btn) {
  const sessionId = /** @type {string} */ (btn.dataset.sessionId);
  const groupId = /** @type {string} */ (btn.dataset.groupId);

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'tag-input';
  input.placeholder = 'tag…';
  input.maxLength = 30;
  input.dataset.fk = 'tagadd:' + sessionId + ':' + groupId;
  btn.replaceWith(input);
  input.focus();

  const commit = async () => {
    const val = input.value.trim();
    if (val) {
      const session = ctx.store.getState().sessions[sessionId];
      const group = session?.groups?.find((/** @type {any} */ g) => g.id === groupId);
      if (group) {
        group.tags = [...(group.tags ?? []), val];
        await ctx.repo.updateSession(sessionId, { groups: session.groups });
        return; // el sync re-pinta
      }
    }
    // Sin cambio: re-pintar para devolver el botón "+ tag"
    ctx.renderer.invalidate();
    ctx.renderer.render();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void commit();
    }
    if (e.key === 'Escape') {
      ctx.renderer.invalidate();
      ctx.renderer.render();
    }
  });
  input.addEventListener('blur', () => void commit(), { once: true });
}

/** @param {any} ctx @param {string} sessionId @param {string|null} groupId @param {string} tabId */
export async function removeTab(ctx, sessionId, groupId, tabId) {
  await ctx.repo.removeTabFromSession(sessionId, groupId, tabId);
  showToast(ctx, 'Tab removed');
}

/** @param {any} ctx @param {string} sessionId @param {string} groupId */
export async function removeGroup(ctx, sessionId, groupId) {
  await ctx.repo.removeGroupFromSession(sessionId, groupId);
  showToast(ctx, 'Group removed');
}

/** @param {any} ctx @param {string} sessionId */
export async function addCurrentTab(ctx, sessionId) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !isValidTabUrl(tab.url ?? '')) {
    showToast(ctx, 'Cannot add this tab', 'error');
    return;
  }
  let favicon = '';
  try {
    const res = await sendToBackground({ type: MSG.CONVERT_FAVICON, url: tab.favIconUrl || '' });
    favicon = /** @type {any} */ (res)?.data?.dataUrl ?? '';
  } catch {
    favicon = '';
  }
  await ctx.repo.addTabToSession(sessionId, {
    id: ctx.repo.generateId(),
    url: tab.url ?? '',
    title: tab.title || tab.url,
    favicon,
    note: '',
    tags: [],
    savedAt: Date.now(),
  });
  showToast(ctx, 'Tab added', 'success');
}

/** @param {any} ctx @param {string} sessionId @param {number} index */
export async function restoreVersionAction(ctx, sessionId, index) {
  try {
    await ctx.repo.restoreVersion(sessionId, index);
    showToast(ctx, 'Version restored', 'success');
  } catch (e) {
    showToast(ctx, /** @type {Error} */ (e).message, 'error');
  }
}

// ─── Guardar sesión (Fases 6.1/6.4: captura selectiva + duplicados v2) ───────

/**
 * Fila del preview de captura selectiva. Pura y testeable.
 * @param {{ url: string, title?: string, favicon?: string }[]} liveTabs
 * @param {string[]} excludedDomains
 * @returns {{ url: string, title: string, favicon: string, domain: string, checked: boolean }[]}
 */
export function buildSavePreviewRows(liveTabs, excludedDomains = []) {
  const excluded = new Set(excludedDomains.map((d) => String(d).toLowerCase()));
  return liveTabs
    .filter((t) => isValidTabUrl(t.url))
    .map((t) => {
      const domain = domainOf(t.url);
      return {
        url: t.url,
        title: t.title || t.url,
        favicon: t.favicon ?? '',
        domain,
        checked: !excluded.has(domain),
      };
    });
}

/** @param {string} url */
export function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Top-n dominios de una sesión (para el panel de comparación). @param {any} session @param {number} [n] */
export function sessionTopDomains(session, n = 3) {
  if (!session) return [];
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const url of sessionUrls(session)) {
    const d = domainOf(url);
    if (!d) continue;
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([d]) => d);
}

/** @param {any} ctx */
export function openSaveModal(ctx) {
  openModal('save-modal');
  const state = ctx.store.getState();

  // Auto-nombrado (Fase 6.1): dominios predominantes; fallback fecha.
  const input = /** @type {HTMLInputElement|null} */ (document.getElementById('session-name-input'));
  if (input) input.value = suggestSessionName(liveTabsOf(state)) || fallbackSessionName();

  renderSavePreview(state);
  resetDuplicateUi();
}

/** Tabs vivas válidas del estado actual. @param {any} state @returns {{ url: string, title?: string, favicon?: string }[]} */
function liveTabsOf(state) {
  return [...state.liveGroups.flatMap((/** @type {any} */ g) => g.tabs), ...state.liveUngrouped];
}

/** Pinta las filas con checkbox del modal. @param {any} state */
function renderSavePreview(state) {
  const box = document.getElementById('save-tabs-preview');
  if (!box) return;
  const rows = buildSavePreviewRows(liveTabsOf(state), state.settings?.excludedDomains ?? []);
  document
    .getElementById('save-tabs-count')
    ?.replaceChildren(document.createTextNode(`${rows.length} tab${rows.length !== 1 ? 's' : ''}`));
  if (rows.length === 0) {
    box.innerHTML = '<div class="save-preview-empty">No capturable tabs in this window.</div>';
    return;
  }
  box.innerHTML = rows
    .map(
      (r) => `
    <div class="save-tab-row" title="${escapeAttr(r.url)}">
      <input type="checkbox" class="save-tab-check" data-url="${escapeAttr(r.url)}"
        data-domain="${escapeAttr(r.domain)}" ${r.checked ? 'checked' : ''}>
      ${favIconHtml(r.url, state.favicons)}
      <span class="save-tab-title">${escapeHtml(r.title)}</span>
      <button type="button" class="ban-domain-btn${r.checked ? '' : ' active'}"
        data-action="ban-save-domain" data-domain="${escapeAttr(r.domain)}"
        title="${r.checked ? 'Always skip this domain' : 'Domain skipped — click to include'}"
        aria-label="Toggle exclusion for ${escapeAttr(r.domain)}">${Icon('eyeOff', 11)}</button>
    </div>`
    )
    .join('');
}

function resetDuplicateUi() {
  document.getElementById('duplicate-compare')?.setAttribute('hidden', '');
  const btn = /** @type {any} */ (document.getElementById('modal-confirm'));
  delete btn?._duplicateId;
}

export function closeSaveModal() {
  resetDuplicateUi();
  closeModal('save-modal');
}

/** Duplicado potencial según el umbral configurable (Fase 6.4). @param {any} ctx @param {any} state */
function findDuplicateSession(ctx, state) {
  const currentUrls = new Set(
    [
      ...state.liveGroups.flatMap((/** @type {any} */ g) => g.tabs.map((/** @type {any} */ t) => t.url)),
      ...state.liveUngrouped.map((/** @type {any} */ t) => t.url),
    ].filter((/** @type {string} */ u) => isValidTabUrl(u))
  );
  const threshold = (state.settings?.dupThreshold ?? 80) / 100;
  return findDuplicateOf(currentUrls, state.sessions, threshold);
}

/**
 * Lee el estado actual del modal: nombre + URLs desmarcadas + multi-ventana.
 * @param {HTMLInputElement|null} input
 * @param {boolean} [defaultAllWindows]
 */
function readModalOptions(input, defaultAllWindows = false) {
  const name = input?.value.trim() || '';
  const checks = Array.from(document.querySelectorAll('#save-tabs-preview .save-tab-check'));
  const excludeUrls = checks
    .filter((el) => /** @type {HTMLInputElement} */ (el).checked === false)
    .map((el) => /** @type {HTMLInputElement} */ (el).dataset.url ?? '');
  const allWindows =
    /** @type {HTMLInputElement|null} */ (document.getElementById('save-all-windows'))?.checked ??
    defaultAllWindows;
  return { name, excludeUrls, allWindows };
}

/**
 * Flujo de guardado. Sin `choice`: si hay duplicado muestra la comparación lado
 * a lado y espera decisión explícita (sobrescribir / guardar igual / cancelar).
 * Con `choice` ('overwrite'|'save') ejecuta directamente.
 * @param {any} ctx @param {{ choice?: 'overwrite'|'save', decided?: boolean }} [opts]
 */
export async function confirmSave(ctx, opts = {}) {
  const input = /** @type {HTMLInputElement|null} */ (document.getElementById('session-name-input'));
  const state = ctx.store.getState();
  const options = readModalOptions(input);

  let duplicateId = null;
  let overwrite = false;
  if (!opts.decided) {
    const duplicate = findDuplicateSession(ctx, state);
    if (duplicate && /** @type {any} */ (duplicate).id) {
      showDuplicateCompare(duplicate, buildSavePreviewRows(liveTabsOf(state), []));
      return;
    }
  } else {
    duplicateId = /** @type {any} */ (findDuplicateSession(ctx, state))?.id ?? null;
    overwrite = opts.choice === 'overwrite';
  }

  closeSaveModal();
  await captureCurrentSession(ctx, options, duplicateId, overwrite);
}

/** Rellena el panel de comparación lado a lado. @param {any} duplicate @param {ReturnType<typeof buildSavePreviewRows>} incomingRows */
function showDuplicateCompare(duplicate, incomingRows) {
  const incomingDomains = new Set(incomingRows.map((r) => r.domain));

  const incomingEl = document.getElementById('dup-incoming');
  const existingEl = document.getElementById('dup-existing');
  if (incomingEl) {
    incomingEl.replaceChildren();
    incomingEl.append(
      el('strong', `${incomingRows.length} tabs`),
      document.createTextNode(` · ${incomingDomains.size} domains`)
    );
  }
  if (existingEl) {
    existingEl.replaceChildren();
    existingEl.append(
      el('strong', `"${duplicate.name}"`),
      document.createTextNode(
        ` · ${duplicate.metadata?.tabCount ?? 0} tabs · saved ${formatRelativeTime(duplicate.updated)}`
      ),
      el('div', `Top domains: ${sessionTopDomains(duplicate).join(', ') || '—'}`)
    );
  }
  const compare = document.getElementById('duplicate-compare');
  compare?.removeAttribute('hidden');
  compare?.scrollIntoView({ block: 'nearest' });

  // El id viaja en el botón principal para el envío final.
  const btn = /** @type {any} */ (document.getElementById('modal-confirm'));
  if (btn) btn._duplicateId = duplicate.id;
}

/** @param {string} tag @param {string} text @returns {HTMLElement} */
function el(tag, text) {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

/**
 * Envía la captura al SW e informa dedupe/overwrite en el toast.
 * @param {any} ctx @param {{ name: string, excludeUrls: string[], allWindows: boolean }} options
 * @param {string|null} duplicateId @param {boolean} overwrite
 */
async function captureCurrentSession(ctx, options, duplicateId, overwrite) {
  const saveBtn = document.querySelector('[data-action="open-save-modal"]');
  setSaving(saveBtn, true);
  try {
    const result = await sendToBackground({
      type: MSG.CAPTURE_SESSION,
      name: options.name,
      duplicateId,
      overwrite,
      excludeUrls: options.excludeUrls.length > 0 ? options.excludeUrls : undefined,
      allWindows: options.allWindows || undefined,
    });
    if (result.ok) {
      const saved = /** @type {any} */ (result).data ?? {};
      const parts = [`"${saved.name ?? options.name}" saved`];
      if (saved.dedupeRemoved > 0)
        parts.push(`${saved.dedupeRemoved} duplicate tab${saved.dedupeRemoved !== 1 ? 's' : ''} merged`);
      if (overwrite) parts.push('overwrote similar session');
      showToast(ctx, parts.join(' — '), 'success');
      flashSuccess(saveBtn); // checkmark en el CTA (Fase 5.4)
      void warnIfStorageFull(ctx);
    } else {
      showToast(ctx, /** @type {any} */ (result).error ?? 'Save failed', 'error');
    }
  } catch {
    showToast(ctx, 'Could not save session', 'error');
  } finally {
    setSaving(saveBtn, false);
  }
}

/**
 * Excluir/incluir SIEMPRE un dominio (persistente, base de reglas Fase 9).
 * Actualiza settings Y desmarca/marca sus filas del preview al vuelo.
 * @param {any} ctx @param {HTMLElement} btn
 */
export async function banSaveDomain(ctx, btn) {
  const domain = btn.dataset.domain ?? '';
  if (!domain) return;
  const current = /** @type {string[]} */ (ctx.store.getState().settings?.excludedDomains ?? []);
  const has = current.includes(domain);
  const next = has ? current.filter((d) => d !== domain) : [...current, domain].slice(-64);
  await ctx.repo.saveSettings({ ...ctx.store.getState().settings, excludedDomains: next });
  ctx.store.dispatch({ type: A.SETTINGS_PATCHED, patch: { excludedDomains: next } });

  const skip = !has; // antes no estaba → ahora se excluye
  document
    .querySelectorAll(`#save-tabs-preview .save-tab-check[data-domain="${attrEscape(domain)}"]`)
    .forEach((el) => {
      /** @type {HTMLInputElement} */ (el).checked = !skip;
    });
  document.querySelectorAll('#save-tabs-preview .ban-domain-btn').forEach((b) => {
    if (/** @type {HTMLElement} */ (b).dataset.domain === domain) b.classList.toggle('active', skip);
  });
  showToast(ctx, skip ? `Always skipping ${domain}` : `${domain} included again`, 'success');
}

/** Animación de éxito sobre el botón (clase .save-success en components.css). @param {Element|null} el */
function flashSuccess(el) {
  if (!(el instanceof HTMLElement)) return;
  el.classList.remove('save-success');
  // Reinicio de la animación aunque haya brillado hace poco.
  void (/** @type {HTMLElement} */ (el).offsetWidth);
  el.classList.add('save-success');
  setTimeout(() => el.classList.remove('save-success'), 900);
}

/** @param {Element|null} btn @param {boolean} saving */
function setSaving(btn, saving) {
  if (!(btn instanceof HTMLButtonElement)) return;
  btn.disabled = saving;
  btn.textContent = saving ? 'Saving…' : 'Save';
}

/** Aviso temprano si storage ≥80%. @param {any} ctx */
async function warnIfStorageFull(ctx) {
  try {
    const pct = await ctx.repo.getUsagePercent();
    if (pct >= 80) {
      setTimeout(() => showToast(ctx, 'Storage ' + pct + '% full — export a backup soon', 'error'), 2600);
    }
  } catch {
    /* best-effort */
  }
}

/** @param {string} s */
function attrEscape(s) {
  return String(s).replace(/"/g, '\\"');
}

/** Escape HTML mínimo para strings insertadas en plantillas del modal.
 * @param {string} s */
function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** @param {string} s */
function escapeAttr(s) {
  return escapeHtml(s);
}
