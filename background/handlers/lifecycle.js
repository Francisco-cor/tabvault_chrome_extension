// background/handlers/lifecycle.js — Ciclo de vida MV3 correcto (Fase 3).
// M1: context menus namespaced, creados tras removeAll() con lastError controlado.
// M2: openPopup() con detección de soporte y fallback a tab.
// M5: badge transitorio vía chrome.alarms de un disparo — NUNCA setTimeout,
//     que moría con el SW dejando el badge pegado.

const BADGE_CLEAR_ALARM = 'tabvault-badge-clear';

/**
 * Lee y limpia chrome.runtime.lastError en callbacks fire-and-forget.
 * Wrapper anti "unchecked lastError": usar en TODO callback de API callback-style.
 * @returns {string|null}
 */
export function checkLastError() {
  const err = chrome.runtime.lastError;
  if (err) console.warn('[TabVault] lastError:', err.message ?? 'unknown');
  return err ? (err.message ?? 'unknown lastError') : null;
}

/**
 * Badge transitorio: se programa su limpieza con una alarma de un disparo.
 * Aunque el SW muera antes del `when`, la alarma lo despierta para limpiar (M5).
 * @param {string} text
 * @param {string} color
 * @param {number} [durationMs=3000]
 */
export async function flashBadge(text, color, durationMs = 3000) {
  try {
    await Promise.all([
      chrome.action.setBadgeText({ text }),
      chrome.action.setBadgeBackgroundColor({ color }),
    ]);
    await chrome.alarms.create(BADGE_CLEAR_ALARM, { when: Date.now() + durationMs });
  } catch (e) {
    console.warn('[TabVault] flashBadge failed:', /** @type {any} */ (e)?.message);
  }
}

/** Handler de la alarma de limpieza. @param {{ name: string }} alarm */
export async function handleBadgeAlarm(alarm) {
  if (alarm.name !== BADGE_CLEAR_ALARM) return false;
  try {
    await chrome.action.setBadgeText({ text: '' });
  } finally {
    checkLastError();
  }
  return true;
}

/**
 * Abre la UI del vault. En Chrome <127 openPopup no existe → abre una tab (M2).
 */
export function openVaultUi() {
  const url = chrome.runtime.getURL('popup/popup.html');
  if (typeof chrome.action?.openPopup === 'function') {
    chrome.action.openPopup().catch(() => {
      chrome.tabs.create({ url });
    });
  } else {
    chrome.tabs.create({ url });
  }
}

// ─── Comandos globales de teclado (Fase 7.2: +3 en manifest) ─────────────────

const UI_INTENT_KEY = 'uiIntent';

/**
 * Deja una "intención" en storage.session para que la UI, al arrancar, abra
 * directamente Quick Switcher o Search. storage.session sobrevive al sleep del
 * SW pero se limpia al cerrar el navegador: exactamente el ciclo correcto.
 * @param {'quick-switcher'|'quick-search'} intent
 */
async function setUiIntent(intent) {
  try {
    await chrome.storage.session.set({ [UI_INTENT_KEY]: intent, uiIntentAt: Date.now() });
  } catch {
    /* best-effort: sin intent, el popup simplemente abre normal */
  }
}

/** Lee y CONSUME la intención pendiente (una sola vez). @returns {Promise<string|null>} */
export async function consumeUiIntent() {
  try {
    const res = await chrome.storage.session.get(UI_INTENT_KEY);
    await chrome.storage.session.remove(UI_INTENT_KEY);
    return /** @type {any} */ (res)?.[UI_INTENT_KEY] ?? null;
  } catch {
    return null;
  }
}

/**
 * Ejecuta un comando global (chrome.commands). Devuelve true si lo manejó.
 * - quick-switcher / quick-search: marcan intención + abren la UI.
 * - toggle-theme: alterna dark/light SIN abrir UI (system → light).
 * Extraído a función pura-ish para poder testearlo sin cargar sw-main.
 *
 * @param {string} command
 * @param {{ repo: { getSettings: () => Promise<any>, saveSettings: (s: any) => Promise<any> },
 *           openUi?: () => void }} deps
 * @returns {Promise<boolean>}
 */
export async function handleGlobalCommand(command, deps) {
  switch (command) {
    case 'quick-switcher':
      await setUiIntent('quick-switcher');
      (deps.openUi ?? openVaultUi)();
      return true;
    case 'quick-search':
      await setUiIntent('quick-search');
      (deps.openUi ?? openVaultUi)();
      return true;
    case 'toggle-theme': {
      const settings = await deps.repo.getSettings();
      // matchMedia no existe en SW: 'system' se trata como dark (mayoría) → light.
      const current = settings.theme === 'light' ? 'light' : 'dark';
      await deps.repo.saveSettings({ ...settings, theme: current === 'dark' ? 'light' : 'dark' });
      return true;
    }
    default:
      return false;
  }
}

/** Id del badge persistente de stash: se limpia solo desde el popup. */
export const STASH_BADGE_COLOR = '#4169E1';

/**
 * Badge PERSISTENTE con el contador de tabs en el Stash (Fase 6.1).
 * A diferencia de flashBadge NO programa limpieza: muere cuando el popup
 * se abre (clearStashBadge) o cuando otro flujo pisa el badge.
 * @param {number} count
 */
export async function setStashBadge(count) {
  try {
    if (!count || count <= 0) return;
    await Promise.all([
      chrome.action.setBadgeText({ text: String(Math.min(count, 99)) }),
      chrome.action.setBadgeBackgroundColor({ color: STASH_BADGE_COLOR }),
    ]);
  } catch (e) {
    console.warn('[TabVault] setStashBadge failed:', /** @type {any} */ (e)?.message);
  }
}

/** Limpia el contador de stash (popup abierto = stash visto). */
export async function clearStashBadge() {
  try {
    await chrome.action.setBadgeText({ text: '' });
  } catch {
    /* best-effort */
  }
}

/**
 * Registra los context menus de forma idempotente (M1):
 * removeAll primero; creates DENTRO del callback; ids namespaced.
 */
export function registerContextMenus() {
  chrome.contextMenus.removeAll(() => {
    if (checkLastError()) return; // sin lastError limpio no se puede crear seguro
    for (const def of [
      { id: 'tabvault_save_session', title: 'Save session — TabVault' },
      { id: 'tabvault_stash_page', title: 'Stash this page — TabVault' },
      { id: 'tabvault_open_popup', title: 'Open TabVault' },
    ]) {
      chrome.contextMenus.create(
        {
          id: def.id,
          title: def.title,
          contexts: ['page', 'frame'],
        },
        () => checkLastError()
      );
    }
  });
}

/** Ids válidos del menú contextual. @returns {Set<string>} */
export function contextMenuIds() {
  return new Set(['tabvault_save_session', 'tabvault_stash_page', 'tabvault_open_popup']);
}
