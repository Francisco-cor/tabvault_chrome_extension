// ui/events.js — Delegación de eventos ÚNICA sobre #content (muerte definitiva de C6).
// Se registra UNA vez en el bootstrap; cada render solo cambia el HTML, jamás
// vuelve a llamar addEventListener. La tabla enruta data-action → handler.
// Fase 7 añade: operadores de búsqueda, filtros combinados, tags sesión/tab,
// acciones live (cerrar/pin/stash/guardar grupo) y D&D de cards manual.

import { A } from './actions.js';
import { createDragController, createCardDragController } from './components/DragController.js';
import { installScrollBus } from './components/VirtualList.js';
import { scheduleHoverPreview, cancelHoverPreview } from './components/HoverPreview.js';
import { openTagManager } from './components/TagManager.js';
import * as sessionActions from './actions/sessionActions.js';
import * as bulkActions from './actions/bulkActions.js';
import * as noteActions from './actions/noteActions.js';
import * as settingsActions from './actions/settingsActions.js';
import * as vaultActions from './actions/vaultActions.js';
import * as liveActions from './actions/liveActions.js';
import { visibleSessions } from './views/SessionsView.js';
import { MSG, sendToBackground } from '../shared/messages.js';
import { newId } from '../core/domain.js';

/** Debounce de búsqueda: 80ms según presupuesto de Fase 7.1. */
const SEARCH_DEBOUNCE_MS = 80;
let searchTimer = /** @type {ReturnType<typeof setTimeout>|null} */ (null);

/** @param {HTMLElement|null} el @param {string} sel */
function closestAction(el, sel = '[data-action]') {
  return /** @type {HTMLElement|null} */ (el?.closest(sel) ?? null);
}

/** dataset como strings con fallback '' @param {HTMLElement|null} el @param {string} key */
const d = (el, key) => /** @type {HTMLElement} */ (el).dataset[key] ?? '';

/**
 * Tabla click: action → handler(ctx, el, e). Los handlers async se envuelven
 * en void al invocarse; la tabla es plano y escaneable a propósito.
 * @type {Record<string, (ctx: any, el: HTMLElement, e: Event) => void>}
 */
const CLICK_ACTIONS = {
  'reload-ui': () => location.reload(),
  back: (ctx) => {
    if (!ctx.router.back()) ctx.router.setRoot('sessions');
  },
  detail: (ctx, el) => sessionActions.openDetail(ctx, d(el, 'id')),

  'open-save-modal': (ctx) => sessionActions.openSaveModal(ctx),
  restore: (ctx, el) => void sessionActions.restoreNewWindow(ctx, d(el, 'id')),
  'restore-menu': (ctx, el) => sessionActions.showRestoreMenu(ctx, el, d(el, 'id')),
  'toggle-template': (ctx, el) => void sessionActions.toggleTemplate(ctx, d(el, 'id')),
  'toggle-template-filter': (ctx) => ctx.store.dispatch({ type: A.TEMPLATES_FILTER_TOGGLED }),
  'open-selected-tabs': (ctx) => void sessionActions.openSelectedTabs(ctx),
  'export-menu': (ctx, el) => vaultActions.showExportMenu(ctx, el, d(el, 'id')),
  delete: (ctx, el) => void sessionActions.deleteSoft(ctx, d(el, 'id')),
  pin: (ctx, el) => void sessionActions.togglePin(ctx, d(el, 'id')),
  rename: (ctx, el, e) => {
    const nameEl = closestAction(/** @type {HTMLElement} */ (e.target), '.session-name') ?? el;
    sessionActions.startRename(ctx, nameEl, d(el, 'id'));
  },
  'bulk-check': (ctx, el) => bulkActions.toggleBulkCheck(ctx, d(el, 'id')),
  'bulk-toggle': (ctx) => bulkActions.setBulkMode(ctx, !ctx.store.getState().bulkMode),

  'toggle-filter-tag': (ctx, el) => ctx.store.dispatch({ type: A.TAG_FILTER_TOGGLED, tag: d(el, 'tag') }),
  'toggle-pinned-filter': (ctx) =>
    ctx.store.dispatch({
      type: A.FILTERS_PATCHED,
      patch: { pinnedOnly: !ctx.store.getState().activeFilters.pinnedOnly },
    }),
  'clear-filters': (ctx) => {
    const state = ctx.store.getState();
    ctx.store.dispatch({ type: A.FILTERS_CLEARED });
    for (const t of [...state.filterTags]) {
      ctx.store.dispatch({ type: A.TAG_FILTER_TOGGLED, tag: t });
    }
    if (state.templatesOnly) ctx.store.dispatch({ type: A.TEMPLATES_FILTER_TOGGLED });
  },
  'manage-tags': (ctx) => openTagManager(ctx),
  'insert-operator': (ctx, el) => insertSearchOperator(ctx, d(el, 'op')),

  // Live groups (Fase 7.6)
  'live-tab-close': (ctx, el) => void liveActions.closeLiveTab(ctx, el),
  'live-tab-pin': (ctx, el) => void liveActions.pinLiveTab(ctx, el),
  'live-tab-stash': (ctx, el) => void liveActions.stashLiveTab(ctx, el),
  'save-group-session': (ctx, el) =>
    void liveActions.saveGroupAsSession(
      ctx,
      ctx.store.getState().activeWindowId,
      d(el, 'groupId'),
      undefined
    ),

  'toggle-live-group': (ctx, el) =>
    ctx.store.dispatch({ type: A.EXPANSION_TOGGLED, key: 'live-' + d(el, 'groupId') }),

  // Tags sesión/tab (Fase 7.3)
  'remove-session-tag': (ctx, el) =>
    void sessionActions.removeSessionTag(ctx, d(el, 'sessionId'), Number(d(el, 'tagIndex'))),
  'add-tab-tag': (ctx, el) => sessionActions.startAddTabTag(ctx, /** @type {HTMLButtonElement} */ (el)),
  'remove-tab-tag': (ctx, el) =>
    void sessionActions.removeTabTag(
      ctx,
      d(el, 'sessionId'),
      d(el, 'groupId') || null,
      d(el, 'tabId'),
      Number(d(el, 'tagIndex'))
    ),

  'add-current-tab': (ctx, el) => void sessionActions.addCurrentTab(ctx, d(el, 'sessionId')),
  'remove-tab': (ctx, el) =>
    void sessionActions.removeTab(ctx, d(el, 'sessionId'), d(el, 'groupId') || null, d(el, 'tabId')),
  'remove-group': (ctx, el) => void sessionActions.removeGroup(ctx, d(el, 'sessionId'), d(el, 'groupId')),
  'remove-group-tag': (ctx, el) =>
    void sessionActions.removeGroupTag(ctx, d(el, 'sessionId'), d(el, 'groupId'), Number(d(el, 'tagIndex'))),
  'add-group-tag': (ctx, el) => sessionActions.startAddGroupTag(ctx, /** @type {HTMLButtonElement} */ (el)),
  'toggle-versions': (ctx) => ctx.store.dispatch({ type: A.VERSIONS_TOGGLED }),
  'restore-version': (ctx, el) =>
    void sessionActions.restoreVersionAction(ctx, d(el, 'sessionId'), Number(d(el, 'versionIndex'))),

  'restore-trash': (ctx, el) => void vaultActions.restoreFromTrash(ctx, d(el, 'id')),
  'delete-permanent': (ctx, el) => vaultActions.openDeleteModal(ctx, d(el, 'id')),
  'remove-excluded-domain': (ctx, el) => void settingsActions.removeExcludedDomain(ctx, el),
  'remove-focus-whitelist': (ctx, el) => void removeFocusWhitelist(ctx, el),

  // Portabilidad y respaldos (Fase 8)
  'export-from-reminder': (ctx, el) => vaultActions.openExportMenu(ctx, el),
  'dismiss-export-reminder': (ctx) => void vaultActions.dismissExportReminder(ctx),
  'export-data-json': (ctx) => void vaultActions.exportAll(ctx),
  'export-data-bookmarks': (ctx) => void vaultActions.exportBookmarksAll(ctx),
  'export-data-encrypted': (ctx) => void vaultActions.exportEncrypted(ctx),
  'backup-now': (ctx) => void vaultActions.createManualBackup(ctx),
  'backup-download': (ctx, el) => vaultActions.downloadBackup(ctx, el),
  'backup-restore': (ctx, el) => vaultActions.restoreBackupClick(ctx, el),
  'backup-delete': (ctx, el) => vaultActions.deleteBackupClick(ctx, el),

  // Fase 9: productividad
  'open-stats': (ctx) => ctx.router.push('stats'),
  'focus-session': (ctx, el) => void handleFocus(ctx, d(el, 'sessionId') || d(el, 'id')),
  'suspend-now': (ctx) => void handleSuspend(ctx),
  'add-routine': (ctx) => void handleAddRoutine(ctx),
  'toggle-routine': (ctx, el) => void handleToggleRoutine(ctx, d(el, 'id')),
  'delete-routine': (ctx, el) => void handleDeleteRoutine(ctx, d(el, 'id')),
  'add-rule': (ctx) => void handleAddRule(ctx),
  'delete-rule': (ctx, el) => void handleDeleteRule(ctx, d(el, 'id')),
  'export-rules': (ctx) => void handleExportRules(ctx),

  // Fase 10.5: soporte local (sin red)
  'copy-diagnostics': (ctx) => void handleCopyDiagnostics(ctx),
};

/** Toggles booleanos de settings (botones). @param {string} action @param {HTMLElement} el */
function isSettingsButton(action, el) {
  return action.startsWith('settings-') && el.tagName === 'BUTTON';
}

/**
 * Tabla change: selects/inputs que confirman al cambiar o perder foco.
 * @type {Record<string, (ctx: any, el: HTMLInputElement) => void>}
 */
const CHANGE_ACTIONS = {
  'sort-select': (ctx, el) => void settingsActions.changeSort(ctx, el.value),
  'filters-domain': (ctx, el) =>
    ctx.store.dispatch({
      type: A.FILTERS_PATCHED,
      patch: {
        domain: String(el.value ?? '')
          .trim()
          .toLowerCase(),
      },
    }),
  'filters-range': (ctx, el) =>
    ctx.store.dispatch({ type: A.FILTERS_PATCHED, patch: { range: /** @type {any} */ (el).value } }),
  'live-window-select': (ctx, el) =>
    ctx.store.dispatch({ type: A.ACTIVE_WINDOW_CHANGED, windowId: Number(el.value) }),
  'add-session-tag-input': (ctx, el) => {
    const value = /** @type {string} */ (el.value ?? '');
    el.value = ''; // listo para la siguiente tag
    void sessionActions.addSessionTag(ctx, /** @type {HTMLElement} */ (el).dataset.sessionId ?? '', value);
  },
};

/**
 * Registra TODOS los listeners delegados del contenido. Llamar UNA vez.
 * @param {any} ctx contexto compartido {store, router, repo, mount, renderer, dom, undoToast, live}
 */
export function bindContentEvents(ctx) {
  const content = ctx.mount;

  installScrollBus(content);

  // ── Drag & drop del detalle (instancia única) ────────────────────────────────
  createDragController({
    content,
    getSessionId: () => ctx.store.getState().detailSessionId,
    exec: (decision, sessionId) => execDropDecision(ctx.repo, decision, sessionId),
  });

  // ── D&D de session cards para orden manual (Fase 7.5, instancia única) ──────
  createCardDragController({
    content,
    exec: async (draggedId, toIndex) => {
      const state = ctx.store.getState();
      // La lista visual actual ES la fuente de verdad del nuevo orden;
      // resolveCardDropIndex ya devolvió el índice FINAL en la nueva lista.
      const ids = visibleSessions(state).map((/** @type {any} */ s) => s.id);
      const from = ids.indexOf(draggedId);
      if (from === -1) return;
      const next = [...ids];
      next.splice(from, 1);
      next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, draggedId);
      await ctx.repo.setSessionOrder(next);
      sessionActions.showToast(ctx, 'Order saved', 'success');
    },
  });

  // ── Click: tabla plana ───────────────────────────────────────────────────────
  content.addEventListener('click', (/** @type {MouseEvent} */ e) => {
    const el = closestAction(/** @type {HTMLElement} */ (e.target));
    if (!el) return;
    const action = /** @type {string} */ (el.dataset.action);
    const handler = CLICK_ACTIONS[action];
    if (handler) handler(ctx, el, e);
    else if (isSettingsButton(action, el)) void settingsActions.onSettingToggle(ctx, action, el);
  });

  // ── Doble click = renombrar ──────────────────────────────────────────────────
  content.addEventListener('dblclick', (/** @type {MouseEvent} */ e) => {
    const nameEl = closestAction(
      /** @type {HTMLElement} */ (e.target),
      '.session-name[data-action="rename"]'
    );
    const id = d(nameEl, 'id');
    if (nameEl && id) sessionActions.startRename(ctx, nameEl, id);
  });

  // ── Input (búsqueda con debounce y notas en borrador) ───────────────────────
  content.addEventListener('input', (/** @type {Event} */ e) => {
    const el = /** @type {HTMLInputElement|HTMLTextAreaElement} */ (e.target);
    const action = /** @type {HTMLElement} */ (el).dataset?.action ?? '';
    if (action === 'search-input') {
      clearTimeout(/** @type {Exclude<ReturnType<typeof setTimeout>, null>} */ (searchTimer));
      const val = el.value;
      searchTimer = setTimeout(() => {
        ctx.store.dispatch({ type: A.SEARCH_QUERY_CHANGED, query: val });
        triggerHistory(ctx, val);
      }, SEARCH_DEBOUNCE_MS);
    } else if (action === 'note-group' || action === 'note-tab') {
      noteActions.onNoteInput(ctx, /** @type {HTMLTextAreaElement} */ (el));
    }
  });

  // ── Keydown delegado: Enter en el input de tags de sesión confirma vía
  //    blur → change (los editores inline de grupo/tab tienen su propio
  //    handler de Enter; tocarlos aquí haría doble commit).
  content.addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
    const el = /** @type {HTMLElement} */ (e.target);
    if (e.key === 'Enter' && el.dataset?.action === 'add-session-tag-input') {
      e.preventDefault();
      /** @type {HTMLInputElement} */ (/** @type {unknown} */ (el)).blur();
    }
  });

  // ── Change (tabla plana + checkboxes/settings heredados) ────────────────────
  content.addEventListener('change', (/** @type {Event} */ e) => {
    const el = /** @type {HTMLInputElement} */ (e.target);
    const action = /** @type {HTMLElement} */ (el).dataset?.action ?? '';

    const handler = CHANGE_ACTIONS[action];
    if (handler) return handler(ctx, el);
    if (action === 'detail-tab-check')
      ctx.store.dispatch({ type: A.DETAIL_TAB_CHECKED, tabId: el.dataset.tabId ?? '', on: el.checked });
    else if (action === 'detail-group-check') toggleGroupCheck(ctx, el.dataset.groupId ?? '', el.checked);
    else if (action.startsWith('settings-'))
      void settingsActions.onSettingSelect(ctx, action, /** @type {any} */ (el).value);
    return undefined;
  });

  // ── Hover preview del split de restauración (Fase 6.2) ──────────────────────
  content.addEventListener('mouseover', (/** @type {MouseEvent} */ e) => {
    const split = /** @type {HTMLElement|null} */ (
      /** @type {HTMLElement} */ (e.target)?.closest('.restore-split')
    );
    if (!split) return;
    const id = d(split, 'id');
    if (!id) return;
    scheduleHoverPreview(split, ctx.store.getState().sessions[id] ?? null);
  });
  content.addEventListener('mouseout', (/** @type {MouseEvent} */ e) => {
    const to = /** @type {Node|null} */ (e.relatedTarget);
    const split = /** @type {HTMLElement|null} */ (
      /** @type {HTMLElement} */ (e.target)?.closest('.restore-split')
    );
    if (split && (!to || !split.contains(to))) cancelHoverPreview();
  });

  // ── Focusout: commit inmediato de notas al salir ─────────────────────────────
  content.addEventListener('focusout', (/** @type {FocusEvent} */ e) => {
    const el = /** @type {HTMLTextAreaElement} */ (e.target);
    const action = /** @type {HTMLElement} */ (el).dataset?.action ?? '';
    if (action === 'note-group' || action === 'note-tab') {
      noteActions.onNoteBlur(ctx, el);
    }
  });
}

/**
 * Master checkbox de grupo: marca/desmarca todas sus tabs (Fase 6.2).
 * @param {any} ctx @param {string} groupId @param {boolean} on
 */
function toggleGroupCheck(ctx, groupId, on) {
  const state = ctx.store.getState();
  const session = state.sessions[state.detailSessionId ?? ''];
  const tabs = session?.groups?.find((/** @type {any} */ g) => g.id === groupId)?.tabs ?? [];
  for (const t of tabs) {
    ctx.store.dispatch({ type: A.DETAIL_TAB_CHECKED, tabId: t.id, on });
  }
}

/**
 * Inserta un operador de búsqueda al final del input y dispara el debounce.
 * @param {any} ctx @param {string} op
 */
function insertSearchOperator(ctx, op) {
  if (!op) return;
  const input = /** @type {HTMLInputElement|null} */ (ctx.mount.querySelector('[data-fk="search-input"]'));
  if (!input) return;
  const next = `${input.value.trimEnd()}${input.value.trim() ? ' ' : ''}${op}`;
  input.value = next;
  input.focus();
  clearTimeout(/** @type {Exclude<ReturnType<typeof setTimeout>, null>} */ (searchTimer));
  searchTimer = setTimeout(() => {
    ctx.store.dispatch({ type: A.SEARCH_QUERY_CHANGED, query: next });
    triggerHistory(ctx, next);
  }, SEARCH_DEBOUNCE_MS);
}

/**
 * Fase 9.7: si historyEnabled, pide resultados a SW vía SEARCH_HISTORY y
 * los guarda en el store para que SearchView los muestre.
 * Sin permiso: chrome.history.search no existe → SW responde [].
 * @param {any} ctx @param {string} query
 */
function triggerHistory(ctx, query) {
  const s = ctx.store.getState().settings;
  if (!s?.historyEnabled) {
    ctx.store.dispatch({ type: 'HISTORY_SYNCED', items: [] });
    return;
  }
  if (!query.trim()) {
    ctx.store.dispatch({ type: 'HISTORY_SYNCED', items: [] });
    return;
  }
  void sendToBackground({ type: MSG.SEARCH_HISTORY, query, maxResults: 6 }).then((res) => {
    if (res.ok) ctx.store.dispatch({ type: 'HISTORY_SYNCED', items: res.data });
  });
}

/**
 * Ejecuta una decisión de drop contra el repositorio.
 * @param {any} repo
 * @param {any} decision resultado de resolveDrop()
 * @param {string} sessionId
 */
export function execDropDecision(repo, decision, sessionId) {
  switch (decision.op) {
    case 'reorderTab':
      return repo.reorderTabs(sessionId, decision.groupId, decision.fromIndex, decision.toIndex);
    case 'moveTab':
      return repo.moveTabToGroup(
        sessionId,
        decision.tabId,
        decision.fromGroupId,
        decision.toGroupId,
        decision.toIndex
      );
    case 'reorderGroups':
      return repo.reorderGroups(sessionId, decision.fromIndex, decision.toIndex);
    default:
      return undefined;
  }
}

// ─── Handlers productividad (Fase 9) ─────────────────────────────────────────

/** @param {any} ctx @param {string} sessionId */
async function handleFocus(ctx, sessionId) {
  if (!sessionId) return;
  const res = await sendToBackground({ type: MSG.FOCUS_SESSION, sessionId });
  if (!res.ok) sessionActions.showToast(ctx, res.error ?? 'Focus failed', 'error');
  else {
    const n = /** @type {any} */ (res.data)?.closed ?? 0;
    sessionActions.showToast(
      ctx,
      n === 0 ? 'Already focused' : `${n} tab(s) closed — undo in session list`,
      'success'
    );
    if (res.data?.undoId) {
      // auto-undo hint: open undo via toast button (simplificado: toast clickable)
      void ctx.repo.restoreFromTrash; // placeholder to keep reference
    }
  }
}

/** @param {any} ctx */
async function handleSuspend(ctx) {
  const res = await sendToBackground({ type: MSG.SUSPEND_TABS });
  if (!res.ok) sessionActions.showToast(ctx, res.error ?? 'Suspend failed', 'error');
  else {
    const n = /** @type {any} */ (res.data)?.closed ?? 0;
    sessionActions.showToast(ctx, n === 0 ? 'No inactive tabs' : `${n} tab(s) suspended`, 'success');
  }
}

/** @param {any} ctx */
async function handleAddRoutine(ctx) {
  const sel = /** @type {HTMLSelectElement|null} */ (document.getElementById('routine-session-select'));
  const timeEl = /** @type {HTMLInputElement|null} */ (document.getElementById('routine-time-input'));
  const sessionId = sel?.value ?? '';
  const time = timeEl?.value ?? '';
  if (!sessionId || !time) {
    sessionActions.showToast(ctx, 'Pick a session and time', 'error');
    return;
  }
  try {
    await ctx.repo.saveRoutine({ id: newId(), sessionId, time, enabled: true, created: Date.now() });
    sessionActions.showToast(ctx, 'Routine scheduled', 'success');
  } catch (e) {
    sessionActions.showToast(ctx, e instanceof Error ? e.message : String(e), 'error');
  }
}

/** @param {any} ctx @param {string} id */
async function handleToggleRoutine(ctx, id) {
  try {
    await ctx.repo.toggleRoutine(id);
  } catch (e) {
    sessionActions.showToast(ctx, e instanceof Error ? e.message : String(e), 'error');
  }
}

/** @param {any} ctx @param {string} id */
async function handleDeleteRoutine(ctx, id) {
  try {
    await ctx.repo.deleteRoutine(id);
    sessionActions.showToast(ctx, 'Routine removed', 'success');
  } catch (e) {
    sessionActions.showToast(ctx, e instanceof Error ? e.message : String(e), 'error');
  }
}

/** @param {any} ctx */
async function handleAddRule(ctx) {
  const p = /** @type {HTMLInputElement|null} */ (document.getElementById('rule-pattern-input'));
  const t = /** @type {HTMLInputElement|null} */ (document.getElementById('rule-tag-input'));
  const pattern = p?.value?.trim() ?? '';
  const tag = t?.value?.trim() ?? '';
  if (!pattern || !tag) {
    sessionActions.showToast(ctx, 'Pattern and tag required', 'error');
    return;
  }
  try {
    await ctx.repo.saveAutoTagRule({ pattern, tag });
    if (p) p.value = '';
    if (t) t.value = '';
    sessionActions.showToast(ctx, `Rule added: ${pattern} → ${tag}`, 'success');
  } catch (e) {
    sessionActions.showToast(ctx, e instanceof Error ? e.message : String(e), 'error');
  }
}

/** @param {any} ctx @param {string} id */
async function handleDeleteRule(ctx, id) {
  try {
    await ctx.repo.deleteAutoTagRule(id);
    sessionActions.showToast(ctx, 'Rule removed', 'success');
  } catch (e) {
    sessionActions.showToast(ctx, e instanceof Error ? e.message : String(e), 'error');
  }
}

/** @param {any} ctx */
async function handleExportRules(ctx) {
  const rules = ctx.store.getState().autoTagRules ?? [];
  const blob = new Blob([JSON.stringify(rules, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'tabvault-rules.json';
  a.click();
  URL.revokeObjectURL(url);
}

/** @param {any} ctx @param {HTMLElement} el */
async function removeFocusWhitelist(ctx, el) {
  const domain = el.dataset.domain ?? '';
  const current = ctx.store.getState().settings?.focusWhitelist ?? [];
  await ctx.repo.saveSettings({
    ...ctx.store.getState().settings,
    focusWhitelist: current.filter((/** @type {string} */ d) => d !== domain),
  });
  sessionActions.showToast(ctx, `${domain} removed from whitelist`, 'success');
}

/**
 * Fase 10.5: "Copiar diagnóstico" — informe local al portapapeles.
 * Sin red: logs del ring + errores no manejados + entorno básico.
 * @param {any} ctx
 */
async function handleCopyDiagnostics(ctx) {
  try {
    const { buildSupportReport } = await import('../shared/logger.js');
    const { getDiagnostics } = await import('./services/diagnostics.js');
    const report = await buildSupportReport({ errors: await getDiagnostics() });
    await navigator.clipboard.writeText(report);
    sessionActions.showToast(ctx, 'Diagnostics copied to clipboard', 'success');
  } catch (e) {
    sessionActions.showToast(ctx, `Could not copy: ${e instanceof Error ? e.message : String(e)}`, 'error');
  }
}
