// ui/main.js — Bootstrap del popup/side panel (Fases 4-5).
// Responsabilidades: crear store+router+servicios, cargar datos iniciales,
// registrar UNA vez todos los listeners estáticos/delegados y mantener el
// "chrome" persistente (badges, nav, bulk bar, tema/acento) sincronizado con el store.
// Fase 5 añade: sprite SVG global, reloj de 60s, resync de settings en vivo,
// overlay de atajos (?), confirmación de restauración por teclado (M12) y onboarding.

import { A } from './actions.js';
import { createStore } from './store.js';
import { rootReducer, initialState } from './reducers.js';
import { createRouter } from './router.js';
import { createRenderer } from './render.js';
import { bindContentEvents } from './events.js';
import { createUndoToast, showToast } from './components/Toasts.js';
import { closeMenu, isMenuOpen } from './components/ContextMenu.js';
import { anyModalOpen, closeModal, openModal } from './components/Modal.js';
import { closeShortcuts, isShortcutsOpen, toggleShortcuts } from './components/ShortcutsOverlay.js';
import { isOnboardingOpen, maybeShowOnboarding } from './components/Onboarding.js';
import { isQuickSwitcherOpen, openQuickSwitcher, closeQuickSwitcher } from './components/QuickSwitcher.js';
import { isTagManagerOpen, closeTagManager } from './components/TagManager.js';
import { injectSprite } from './components/Icon.js';
import * as sessionActions from './actions/sessionActions.js';
import * as bulkActions from './actions/bulkActions.js';
import * as settingsActions from './actions/settingsActions.js';
import * as vaultActions from './actions/vaultActions.js';
import { captureAllWindowsLive, createLiveGroups } from './services/liveGroups.js';
import { logDiagnostic } from './services/diagnostics.js';
import { workspacesOf, serializeFilters } from '../core/organization.js';
import { consumeUiIntent } from '../background/handlers/lifecycle.js';
import { SessionsView } from './views/SessionsView.js';
import { GroupsView } from './views/GroupsView.js';
import { DetailView } from './views/DetailView.js';
import { SearchView } from './views/SearchView.js';
import { TrashView } from './views/TrashView.js';
import { SettingsView } from './views/SettingsView.js';
import { StatsView } from './views/StatsView.js';
import { repo } from '../popup/repoClient.js';

// Sprite de iconos ANTES de cualquier render: el chrome estático usa <use href="#tv-*">.
injectSprite(document);

const mount = /** @type {HTMLElement} */ (document.getElementById('content'));

/** Superficie actual: 'popup' | 'panel' (lo declara cada HTML en <html data-surface>). */
export const SURFACE = /** @type {'popup'|'panel'} */ (document.documentElement.dataset.surface ?? 'popup');

const store = createStore(rootReducer, initialState());
const router = createRouter(store);
router.bind(mount);

const undoToast = createUndoToast(document);
const live = createLiveGroups(store);

/** Contexto compartido por servicios, vistas y acciones. */
const ctx = {
  store,
  router,
  repo,
  mount,
  renderer: /** @type {any} */ (null),
  dom: { toast: /** @type {HTMLElement} */ (document.getElementById('toast')) },
  undoToast,
  live,
  surface: SURFACE,
  /** @param {string} sessionId */
  loadVersions: (sessionId) => void sessionActions.loadVersions(ctx, sessionId),
};

const views = {
  sessions: SessionsView,
  groups: GroupsView,
  detail: DetailView,
  search: SearchView,
  trash: TrashView,
  settings: SettingsView,
  stats: StatsView,
};
const renderer = createRenderer({ store, mount, views, ctx });
ctx.renderer = renderer;

// ─── Chrome persistente (fuera de #content) ──────────────────────────────────

/** @param {any} state */
function renderChrome(state) {
  const sessionArr = Object.values(state.sessions);
  const sessionsCount = document.getElementById('sessions-count');
  if (sessionsCount) sessionsCount.textContent = sessionArr.length > 0 ? String(sessionArr.length) : '';
  const trashBadge = document.getElementById('trash-count');
  if (trashBadge) {
    const n = Object.keys(state.trash).length;
    trashBadge.textContent = n > 0 ? String(n) : '';
  }

  document.querySelectorAll('.nav-tab').forEach((btn) => {
    const el = /** @type {HTMLElement} */ (btn);
    const active =
      el.dataset.view === state.view || (state.view === 'detail' && el.dataset.view === 'sessions');
    el.classList.toggle('active', active);
    el.setAttribute('aria-selected', String(active));
  });

  const bulkBar = document.getElementById('bulk-bar');
  if (bulkBar) {
    if (state.bulkMode && state.view === 'sessions') {
      bulkBar.removeAttribute('hidden');
      const count = document.getElementById('bulk-count');
      if (count) count.textContent = `${state.bulkSelected.length} selected`;
    } else {
      bulkBar.setAttribute('hidden', '');
    }
  }

  renderWorkspaceSelect(state);
}

/**
 * Switcher de workspaces del header (Fase 7.4). Visible solo cuando hay
 * workspaces descubiertos; '' = todos.
 * @param {any} state
 */
function renderWorkspaceSelect(state) {
  const select = /** @type {HTMLSelectElement|null} */ (document.getElementById('workspace-select'));
  if (!select) return;
  const workspaces = workspacesOf(state.sessions);
  if (workspaces.length === 0) {
    select.hidden = true;
    return;
  }
  select.hidden = false;
  const current = state.workspace ?? '';
  const options = [
    `<option value="" ${current === '' ? 'selected' : ''}>All workspaces</option>`,
    ...workspaces.map(
      (w) =>
        `<option value="${escapeWs(w.name)}" ${current === w.name ? 'selected' : ''}>@${escapeWs(w.name)} (${w.count})</option>`
    ),
    `<option value="General" ${current === 'General' ? 'selected' : ''}>General</option>`,
  ];
  // Solo re-pinta si cambió el contenido para no matar el foco del select.
  const sig = options.join('|');
  if (select.dataset.sig !== sig) {
    select.innerHTML = options.join('');
    select.dataset.sig = sig;
  }
}

/** @param {string} s */
function escapeWs(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

store.subscribe((/** @type {any} */ state) => {
  renderChrome(state);
  // Listeners de live groups solo mientras la vista Groups está activa.
  if (state.view === 'groups') live.ensure();
  else live.stop();
});

// ─── Sync reactivo con storage.onChanged (Fase 2 → store) ────────────────────
// repo.subscribe entrega la CLAVE tocada ('sessions'|'trash'|'versions'|'settings').

let syncTimer = /** @type {ReturnType<typeof setTimeout>|null} */ (null);
const pendingKeys = /** @type {Set<string>} */ (new Set());
repo.subscribe((key) => {
  if (!['sessions', 'trash', 'settings', 'backups', 'routines', 'autoTagRules', 'favicons'].includes(key)) {
    return;
  }
  pendingKeys.add(key);
  clearTimeout(/** @type {Exclude<ReturnType<typeof setTimeout>, null>} */ (syncTimer));
  syncTimer = setTimeout(() => {
    const keys = [...pendingKeys];
    pendingKeys.clear();
    for (const k of keys) void resyncFromRepo(/** @type {any} */ (k));
  }, 50);
});

/** @param {'sessions'|'trash'|'settings'|'backups'|'routines'|'autoTagRules'|'favicons'} [key] */
async function resyncFromRepo(key) {
  try {
    if (key === 'settings') {
      // Otro contexto cambió preferencias: aplicar tema/acento en vivo.
      const settings = await repo.getSettings();
      if (settings !== ctx.store.getState().settings) {
        ctx.store.dispatch({ type: A.SETTINGS_PATCHED, patch: settings });
        settingsActions.applyFromState(ctx);
        settingsActions.updateThemeIcons(settingsActions.effectiveTheme(ctx));
      }
      return;
    }
    if (key === 'backups') {
      await vaultActions.loadBackups(ctx);
      return;
    }
    if (key === 'routines') {
      const routines = await repo.getRoutines();
      store.dispatch({ type: A.ROUTINES_SYNCED, routines });
      return;
    }
    if (key === 'autoTagRules') {
      const rules = await repo.getAutoTagRules();
      store.dispatch({ type: A.RULES_SYNCED, rules });
      return;
    }
    if (key === 'favicons') {
      const favicons = await repo.getFavicons();
      store.dispatch({ type: A.FAVICONS_SYNCED, favicons });
      return;
    }
    const [sessions, trash] = await Promise.all([repo.getSessions(), repo.getTrash()]);
    const state = store.getState();
    if (sessions !== state.sessions) store.dispatch({ type: A.SESSIONS_SYNCED, sessions });
    if (trash !== state.trash) store.dispatch({ type: A.TRASH_SYNCED, trash });
  } catch (e) {
    console.error('[TabVault UI] resync failed', e);
  }
}

// ─── Reloj: timestamps relativos auto-refrescantes (Fase 5.4) ────────────────

setInterval(() => store.dispatch({ type: A.TICKED, now: Date.now() }), 60_000);

// ─── Hash de filtros combinados (Fase 7.3): compartible/recargable ───────────
// Escribe location.hash cuando los filtros activos cambian (y solo entonces).

let lastHash = /** @type {string|null} */ (null);
store.subscribe((/** @type {any} */ state) => {
  if (!state.ready) return;
  const next = serializeFilters(state.activeFilters);
  if (next === lastHash) return;
  lastHash = next;
  try {
    history.replaceState(null, '', next ? `#${next}` : location.pathname);
  } catch {
    /* contextos sin historial (tests) */
  }
});

// ─── Bindings estáticos (una sola vez) ───────────────────────────────────────

function bindStatic() {
  bindContentEvents(ctx); // delegación única en #content
  bindNavTabs();
  bindHeaderButtons();
  bindWorkspaceSelect();
  bindImportFile();
  bindRulesImport();
  bindSaveModal();
  bindDeleteModal();
  bindMergeModal();
  bindRestoreModal();
  bindImportModal();
  bindPassphraseModal();
  bindBulkBar();
  bindKeyboardNav();
  bindGlobalErrorHandlers();
}

/** Workspace del header → store + settings (persistente, Fase 7.4). */
function bindWorkspaceSelect() {
  document.getElementById('workspace-select')?.addEventListener('change', (e) => {
    const value = /** @type {HTMLInputElement} */ (e.target).value;
    ctx.store.dispatch({ type: A.WORKSPACE_CHANGED, workspace: value });
    const settings = ctx.store.getState().settings;
    if (settings) void repo.saveSettings({ ...settings, workspace: value });
  });
}

function focusSearchInputSoon() {
  requestAnimationFrame(() =>
    /** @type {HTMLInputElement|null} */ (document.querySelector('[data-fk="search-input"]'))?.focus()
  );
}

function bindNavTabs() {
  document.querySelectorAll('.nav-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const view = /** @type {HTMLElement} */ (btn).dataset.view ?? 'sessions';
      router.setRoot(view);
      if (view === 'search') focusSearchInputSoon();
    });
  });
}

function bindHeaderButtons() {
  document
    .getElementById('btn-theme')
    ?.addEventListener('click', () => void settingsActions.toggleTheme(ctx));
  document.getElementById('btn-settings')?.addEventListener('click', () => router.push('settings'));
  document
    .getElementById('btn-export-all')
    ?.addEventListener('click', (e) =>
      vaultActions.openExportMenu(ctx, /** @type {HTMLElement} */ (e.currentTarget))
    );
  document
    .getElementById('btn-import')
    ?.addEventListener('click', (e) =>
      vaultActions.openImportMenu(ctx, /** @type {HTMLElement} */ (e.currentTarget))
    );
  document.getElementById('btn-help')?.addEventListener('click', () => toggleShortcuts());

  document.getElementById('btn-side-panel')?.addEventListener('click', async () => {
    try {
      const win = await chrome.windows.getCurrent();
      await chrome.sidePanel.open({ windowId: /** @type {number} */ (win.id) });
      window.close();
    } catch {
      showToast(ctx.dom.toast, 'Side panel requires Chrome 116+', 'error');
    }
  });
}

function bindImportFile() {
  document
    .getElementById('import-file')
    ?.addEventListener('change', (e) => void vaultActions.onImportFileChange(ctx, e));
}

function bindRulesImport() {
  // Delegated because #import-rules-file lives inside #content (rendered by SettingsView)
  ctx.mount.addEventListener('change', async (e) => {
    const target = /** @type {HTMLInputElement} */ (e.target);
    if (target.id !== 'import-rules-file') return;
    const file = target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) throw new Error('Expected JSON array');
      await ctx.repo.setAutoTagRules(parsed);
      showToast(ctx.dom.toast, 'Rules imported', 'success');
    } catch (err) {
      showToast(ctx.dom.toast, err instanceof Error ? err.message : String(err), 'error');
    } finally {
      target.value = '';
    }
  });
}

/** Preview de importación (Fase 8): shell estática + cuerpo dinámico. */
function bindImportModal() {
  document
    .getElementById('import-confirm')
    ?.addEventListener('click', () => void vaultActions.confirmImport(ctx));
  document.getElementById('import-cancel')?.addEventListener('click', () => vaultActions.closeImportModal());
  // Radios/checkbox del preview: re-render ligero del propio cuerpo.
  document
    .getElementById('import-modal-body')
    ?.addEventListener('change', () => vaultActions.onImportPreviewChange());
  bindOverlayDismiss('import-modal', () => vaultActions.closeImportModal());
}

/** Passphrase para cifrar/descifrar respaldos (Fase 8.2). */
function bindPassphraseModal() {
  document.getElementById('passphrase-ok')?.addEventListener('click', () => vaultActions.submitPassphrase());
  document
    .getElementById('passphrase-cancel')
    ?.addEventListener('click', () => vaultActions.cancelPassphrase());
  document
    .getElementById('passphrase-input')
    ?.addEventListener('keydown', (e) => vaultActions.passphraseKeydown(/** @type {KeyboardEvent} */ (e)));
  bindOverlayDismiss('passphrase-modal', () => vaultActions.cancelPassphrase());
}

/** Overlay click fuera del modal lo cierra. @param {string} id @param {() => void} close */
function bindOverlayDismiss(id, close) {
  document.getElementById(id)?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) close();
  });
}

function bindSaveModal() {
  document
    .getElementById('modal-confirm')
    ?.addEventListener('click', () => void sessionActions.confirmSave(ctx));
  document.getElementById('modal-cancel')?.addEventListener('click', () => sessionActions.closeSaveModal());
  document.getElementById('session-name-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void sessionActions.confirmSave(ctx);
    if (e.key === 'Escape') sessionActions.closeSaveModal();
  });

  // Duplicados v2 (Fase 6.4): decisión explícita sobre la comparación.
  document
    .getElementById('dup-overwrite')
    ?.addEventListener(
      'click',
      () => void sessionActions.confirmSave(ctx, { choice: 'overwrite', decided: true })
    );
  document
    .getElementById('dup-save-anyway')
    ?.addEventListener(
      'click',
      () => void sessionActions.confirmSave(ctx, { choice: 'save', decided: true })
    );
  document.getElementById('dup-cancel')?.addEventListener('click', () => sessionActions.closeSaveModal());

  // Preview de captura selectiva: excluir dominio siempre (6.1).
  const preview = document.getElementById('save-tabs-preview');
  preview?.addEventListener('click', (e) => {
    const row = /** @type {HTMLElement|null} */ (
      /** @type {HTMLElement} */ (e.target)?.closest('.save-tab-row')
    );
    if (!row) return;
    const target = /** @type {HTMLElement} */ (e.target);

    // ⊘ persistente: incluir/excluir SIEMPRE el dominio.
    const banBtn = target.closest('.ban-domain-btn');
    if (banBtn) {
      e.preventDefault();
      void sessionActions.banSaveDomain(ctx, /** @type {HTMLElement} */ (banBtn));
      return;
    }
    // Click directo en el checkbox: comportamiento nativo.
    if (target.closest('.save-tab-check') || e.target === row) return;
    // La fila es un div (no label): toggle manual, sin doble cambio nativo.
    e.preventDefault();
    const check = /** @type {HTMLInputElement|null} */ (row.querySelector('.save-tab-check'));
    if (check) check.checked = !check.checked;
  });

  bindOverlayDismiss('save-modal', () => sessionActions.closeSaveModal());
}

function bindDeleteModal() {
  document
    .getElementById('delete-confirm')
    ?.addEventListener('click', () => void vaultActions.confirmDelete(ctx));
  document.getElementById('delete-cancel')?.addEventListener('click', () => vaultActions.closeDeleteModal());
  bindOverlayDismiss('delete-modal', () => vaultActions.closeDeleteModal());
}

function bindMergeModal() {
  document
    .getElementById('merge-confirm')
    ?.addEventListener('click', () => void bulkActions.confirmMerge(ctx));
  document.getElementById('merge-cancel')?.addEventListener('click', () => bulkActions.closeMergeModal());
  document.getElementById('merge-name-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void bulkActions.confirmMerge(ctx);
    if (e.key === 'Escape') bulkActions.closeMergeModal();
  });
  bindOverlayDismiss('merge-modal', () => bulkActions.closeMergeModal());
}

// ─── Restaurar con confirmación desde teclado (M12, Fase 5.2) ────────────────

let pendingRestoreId = /** @type {string|null} */ (null);

/**
 * Abre el modal de confirmación para restaurar una sesión (Shift+R / menú).
 * @param {string} sessionId
 */
export function requestRestoreConfirm(sessionId) {
  const session = /** @type {any} */ (store.getState()).sessions[sessionId];
  if (!session) return;
  pendingRestoreId = sessionId;
  const desc = document.getElementById('restore-modal-desc');
  if (desc)
    desc.textContent = `Open "${session.name}" (${session.metadata?.tabCount ?? 0} tabs) in a new window?`;
  openModal('restore-modal');
}

function closeRestoreModal() {
  closeModal('restore-modal');
  pendingRestoreId = null;
}

function bindRestoreModal() {
  document.getElementById('restore-confirm')?.addEventListener('click', () => {
    const id = pendingRestoreId;
    closeRestoreModal();
    if (id) void sessionActions.restoreNewWindow(ctx, id);
  });
  document.getElementById('restore-cancel')?.addEventListener('click', closeRestoreModal);
  bindOverlayDismiss('restore-modal', closeRestoreModal);
}

function bindBulkBar() {
  document.getElementById('bulk-delete')?.addEventListener('click', () => void bulkActions.bulkDelete(ctx));
  document.getElementById('bulk-export')?.addEventListener('click', () => void bulkActions.bulkExport(ctx));
  document.getElementById('bulk-merge')?.addEventListener('click', () => bulkActions.openMergeModal(ctx));
  document
    .getElementById('bulk-cancel')
    ?.addEventListener('click', () => bulkActions.setBulkMode(ctx, false));
}

function bindGlobalErrorHandlers() {
  window.addEventListener('unhandledrejection', (e) => {
    const reason = /** @type {any} */ (e).reason;
    console.error('[TabVault UI] unhandled rejection', reason);
    void logDiagnostic(reason);
    showToast(ctx.dom.toast, 'Unexpected error', 'error');
  });
  window.addEventListener('error', (e) => {
    void logDiagnostic(e.error ?? e.message);
  });
}

// ─── Navegación por teclado ──────────────────────────────────────────────────

function isEditing() {
  const el = document.activeElement;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.getAttribute('contenteditable') === 'true';
}

function focusSearch() {
  if (store.getState().view !== 'search') router.setRoot('search');
  focusSearchInputSoon();
}

/**
 * Esc con prioridad: overlays globales → menú → modales → bulk → pop de vista.
 * (El onboarding no se cierra con Esc a propósito: exige Skip explícito.)
 */
function handleEscape() {
  if (isQuickSwitcherOpen()) return closeQuickSwitcher();
  if (isTagManagerOpen()) return closeTagManager();
  if (isShortcutsOpen()) return closeShortcuts();
  if (isMenuOpen()) return closeMenu();
  if (anyModalOpen('save-modal')) return sessionActions.closeSaveModal();
  if (anyModalOpen('delete-modal')) return vaultActions.closeDeleteModal();
  if (anyModalOpen('merge-modal')) return bulkActions.closeMergeModal();
  if (anyModalOpen('restore-modal')) return closeRestoreModal();
  // Fase 8: Esc cancela passphrase (resuelve null) y cierra el preview.
  if (anyModalOpen('passphrase-modal')) return vaultActions.cancelPassphrase();
  if (anyModalOpen('import-modal')) return vaultActions.closeImportModal();
  if (store.getState().bulkMode) return bulkActions.setBulkMode(ctx, false);
  router.back();
  return undefined;
}

function bindKeyboardNav() {
  document.addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
    if (handleOverlayKeys(e)) return;
    if (store.getState().view === 'sessions' && !isEditing() && !isOnboardingOpen()) {
      handleSessionKeys(e);
    }
  });
}

/**
 * Atajos de overlays y búsqueda: Ctrl+K, '?', '/', Escape.
 * Devuelve true si el evento quedó consumido.
 * @param {KeyboardEvent} e
 */
function handleOverlayKeys(e) {
  // Ctrl+K / Ctrl+Shift+P = Quick Switcher (Fase 7.2). Funciona incluso
  // mientras se edita: es el atajo de escape por excelencia.
  if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    if (isQuickSwitcherOpen()) closeQuickSwitcher();
    else openQuickSwitcher(ctx);
    return true;
  }
  if (e.key === '?' && !isEditing()) {
    e.preventDefault();
    toggleShortcuts();
    return true;
  }
  if (e.key === '/' && !isEditing()) {
    e.preventDefault();
    if (isShortcutsOpen()) closeShortcuts();
    focusSearch();
    return true;
  }
  if (e.key === 'Escape') {
    handleEscape();
    return true;
  }
  return false;
}

/**
 * Flechas/j/k navegan; Enter abre detalle; Shift+R restaura CON confirmación (M12).
 * La restauración destructiva sin confirmación murió en Fase 5.
 * @param {KeyboardEvent} e
 */
function handleSessionKeys(e) {
  if (e.key === 'R' && e.shiftKey) {
    e.preventDefault();
    const id = focusedCardId();
    if (id) requestRestoreConfirm(id);
    return;
  }
  const cards = Array.from(document.querySelectorAll('.session-card:not(.trash-card)'));
  if (cards.length === 0) return;
  const state = store.getState();
  const focusedId = () => /** @type {HTMLElement} */ (cards[state.kbIndex])?.dataset.id;

  if (e.key === 'ArrowDown' || e.key === 'j') {
    e.preventDefault();
    const idx = Math.min(state.kbIndex + 1, cards.length - 1);
    store.dispatch({ type: A.KB_INDEX_MOVED, index: idx });
    updateKbFocus(cards, idx);
  } else if (e.key === 'ArrowUp' || e.key === 'k') {
    e.preventDefault();
    const idx = Math.max(state.kbIndex - 1, 0);
    store.dispatch({ type: A.KB_INDEX_MOVED, index: idx });
    updateKbFocus(cards, idx);
  } else if (e.key === 'Enter' && state.kbIndex >= 0) {
    e.preventDefault();
    const id = focusedId();
    if (id) sessionActions.openDetail(ctx, id);
  }
}

/** id de la card enfocada por kb según el índice del store. */
function focusedCardId() {
  const state = store.getState();
  const cards = Array.from(document.querySelectorAll('.session-card:not(.trash-card)'));
  return /** @type {HTMLElement|undefined} */ (cards[state.kbIndex])?.dataset.id ?? null;
}

/** @param {Element[]} cards @param {number} index */
function updateKbFocus(cards, index) {
  cards.forEach((c, i) => c.classList.toggle('kb-focus', i === index));
  cards[index]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ─── Init ────────────────────────────────────────────────────────────────────

/**
 * Popup abierto = stash visto: limpia el badge contador del stash (Fase 6.1).
 * El contador lo pone el SW al stashear y persiste hasta que la UI se abre.
 */
function clearStashBadgeSoon() {
  setTimeout(() => {
    try {
      void chrome.action?.setBadgeText?.({ text: '' });
    } catch {
      /* best-effort */
    }
  }, 400);
}

async function init() {
  bindStatic();
  clearStashBadgeSoon();

  try {
    // Fase 10.1 (budget init ≤150ms): el camino crítico NO espera a las
    // ventanas vivas — llegan después vía LIVE_DATA_UPDATED. Sessions/trash/
    // settings son lo único que la primera pintura necesita.
    void captureAllWindowsLive()
      .then((liveData) => {
        store.dispatch({
          type: A.LIVE_DATA_UPDATED,
          groups: liveData.groups,
          ungrouped: liveData.ungrouped,
          windows: liveData.windows,
          activeWindowId: liveData.activeWindowId,
        });
      })
      .catch(() => {});

    const [sessions, trash, settings, routines, rules, favicons] = await Promise.all([
      repo.getSessions(),
      repo.getTrash(),
      repo.getSettings(),
      repo.getRoutines().catch(() => []),
      repo.getAutoTagRules().catch(() => []),
      repo.getFavicons().catch(() => ({ entries: {}, bytes: 0 })),
    ]);

    const effective = { ...settings };
    if (settings.syncEnabled) {
      try {
        const synced = await repo.loadSyncSettings();
        if (synced) {
          effective.theme = synced.theme ?? effective.theme;
          effective.sortBy = synced.sortBy ?? effective.sortBy;
          effective.accent = synced.accent ?? effective.accent;
        }
      } catch {
        /* sync best-effort */
      }
    }

    store.dispatch({
      type: A.APP_READY,
      sessions,
      trash,
      settings: effective,
      routines,
      rules,
    });
    // Fase 10.2: el store LRU de favicons llega aparte (no bloquea APP_READY).
    store.dispatch({ type: A.FAVICONS_SYNCED, favicons });

    // Fase 10.1: marca de fin de arranque para el budget E2E (init→interactivo).
    try {
      performance.mark('tv-ready');
    } catch {
      /* entornos sin performance */
    }

    // Tema/acento tras conocer las settings (soporta 'system').
    settingsActions.applyFromState(ctx);
    settingsActions.updateThemeIcons(settingsActions.effectiveTheme(ctx));

    // Cambios del SO mientras la UI está abierta (tema system).
    settingsActions.watchSystemTheme(ctx);

    // Comandos globales (Fase 7.2): el SW deja la intención en storage.session
    // y esta UI la consume UNA vez al arrancar para abrir el switcher/search.
    const intent = await consumeUiIntent();
    if (intent === 'quick-switcher') openQuickSwitcher(ctx);
    else if (intent === 'quick-search') {
      router.setRoot('search');
      focusSearchInputSoon();
    }

    // Onboarding de primera vez (3 pasos, dismissible).
    maybeShowOnboarding(ctx, async () => {
      const current = ctx.store.getState().settings ?? effective;
      await repo.saveSettings({ ...current, onboardingDone: true });
    });

    // Ring-buffer de backups para la sección Data & backups (Fase 8.3).
    void vaultActions.loadBackups(ctx);
  } catch (e) {
    console.error('[TabVault UI] init failed', e);
    void logDiagnostic(e);
    // Estado vacío usable en lugar de pantalla muerta.
    store.dispatch({
      type: A.APP_READY,
      sessions: {},
      trash: {},
      settings: { theme: 'dark', accent: 'blue', sortBy: 'newest' },
      liveGroups: [],
      liveUngrouped: [],
    });
    showToast(ctx.dom.toast, 'Could not load data', 'error');
  }
}

init();
