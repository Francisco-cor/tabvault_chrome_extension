// ui/actions/settingsActions.js — Cambios de preferencias: patch optimista en el
// store + persistencia vía repo.saveSettings (SW reprograma alarms si aplica).
// Fase 5.4: temas dark/light/system + 4 acentos vía data-* en <html>.

import { A } from '../actions.js';
import { showToast } from './sessionActions.js';

/**
 * Selects numéricos del panel (id → campo de Settings).
 * @type {Record<string, string>}
 */
const SELECT_FIELDS = {
  'settings-autosave': 'autoSaveMinutes',
  'settings-min-tabs': 'minAutoSaveTabs',
  'settings-purge': 'trashPurgeDays',
  'settings-dup-threshold': 'dupThreshold',
  'settings-suspend-hours': 'suspendHours',
};

/** Selects de texto (tema/acento). @type {Record<string, string>} */
const STRING_FIELDS = {
  'settings-theme': 'theme',
  'settings-accent': 'accent',
};

/** Toggles booleanos. @type {Record<string, string>} */
const TOGGLE_FIELDS = {
  'settings-autosave-close': 'autoSaveOnClose',
  'settings-incognito': 'includeIncognito',
  'settings-dedupe-restore': 'dedupeOnRestore',
  'settings-dedupe-save': 'dedupeOnSave',
  'settings-sync': 'syncEnabled',
  'settings-newtab': 'newTabEnabled',
  'settings-history': 'historyEnabled',
};

const VALID_ACCENTS = new Set(['blue', 'purple', 'green', 'orange']);

/**
 * Puro: resuelve el tema efectivo. 'system' depende de prefers-color-scheme.
 * @param {'dark'|'light'|'system'|string} theme
 * @param {boolean} prefersDark resultado de matchMedia('(prefers-color-scheme: dark)')
 * @returns {'dark'|'light'}
 */
export function resolveTheme(theme, prefersDark) {
  if (theme === 'system') return prefersDark ? 'dark' : 'light';
  return theme === 'light' ? 'light' : 'dark';
}

/**
 * Aplica tema resuelto + acento al <html> (data-theme / data-accent).
 * @param {'dark'|'light'} resolved
 * @param {string} [accent]
 */
export function applyAppearance(resolved, accent) {
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.classList.toggle('light', resolved === 'light'); // compat selectores heredados
  if (accent && VALID_ACCENTS.has(accent)) root.dataset.accent = accent;
}

/**
 * @param {any} ctx
 * @param {string} actionId data-action del control
 * @param {string} rawValue valor del select
 */
export async function onSettingSelect(ctx, actionId, rawValue) {
  const stringField = STRING_FIELDS[actionId];
  if (stringField) {
    const value = rawValue;
    await patchAndSave(ctx, { [stringField]: value });
    if (stringField === 'theme') {
      applyFromState(ctx);
      updateThemeIcons(effectiveTheme(ctx));
    } else {
      applyFromState(ctx);
      showToast(ctx, `Accent: ${value}`, 'success');
    }
    return;
  }
  const field = SELECT_FIELDS[actionId];
  if (!field) return;
  const value = parseInt(rawValue, 10);
  await patchAndSave(ctx, { [field]: value });
  announce(ctx, field, value);
}

/**
 * @param {any} ctx
 * @param {string} actionId
 * @param {HTMLElement} el botón toggle (se le alterna la clase .on)
 */
export async function onSettingToggle(ctx, actionId, el) {
  const field = TOGGLE_FIELDS[actionId];
  if (!field) return;
  const current = !!ctx.store.getState().settings?.[field];
  const next = !current;
  el.classList.toggle('on', next);
  el.setAttribute('aria-pressed', String(next));
  await patchAndSave(ctx, { [field]: next });
  announceToggle(ctx, field, next);
}

/** Quita un dominio de la lista de exclusiones (Fase 6.6).
 * @param {any} ctx @param {HTMLElement} el */
export async function removeExcludedDomain(ctx, el) {
  const domain = el.dataset.domain ?? '';
  const current = ctx.store.getState().settings?.excludedDomains ?? [];
  await patchAndSave(ctx, { excludedDomains: current.filter((/** @type {string} */ d) => d !== domain) });
  showToast(ctx, `${domain} no longer skipped`, 'success');
}

/** Orden de la lista de sesiones. @param {any} ctx @param {string} sortBy */
export async function changeSort(ctx, sortBy) {
  ctx.store.dispatch({ type: A.SORT_CHANGED, sortBy });
  await saveAll(ctx);
}

/** Tema claro/oscuro explícito desde el header. @param {any} ctx */
export async function toggleTheme(ctx) {
  const current = effectiveTheme(ctx);
  const theme = current === 'light' ? 'dark' : 'light';
  await patchAndSave(ctx, { theme });
  applyFromState(ctx);
  updateThemeIcons(theme);
}

/** Tema efectivo del estado, resuelto contra el SO. @param {any} ctx */
export function effectiveTheme(ctx) {
  const stored = ctx.store.getState().settings?.theme ?? 'dark';
  const prefersDark =
    typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)').matches : true;
  return resolveTheme(stored, prefersDark);
}

/** Sincroniza <html> con las settings del store. @param {any} ctx */
export function applyFromState(ctx) {
  const s = ctx.store.getState().settings ?? {};
  applyAppearance(effectiveTheme(ctx), s.accent ?? 'blue');
}

/** Visibilidad de los íconos sol/luna del header. @param {'dark'|'light'} resolved */
export function updateThemeIcons(resolved) {
  const dark = document.getElementById('theme-icon-dark');
  const light = document.getElementById('theme-icon-light');
  if (dark) dark.style.display = resolved === 'light' ? 'block' : 'none';
  if (light) light.style.display = resolved === 'light' ? 'none' : 'block';
}

/**
 * Escucha cambios del SO mientras la UI está abierta (solo relevante con 'system').
 * Devuelve función de limpieza.
 * @param {any} ctx
 */
export function watchSystemTheme(ctx) {
  if (typeof matchMedia !== 'function') return () => {};
  const mq = matchMedia('(prefers-color-scheme: dark)');
  const handler = () => {
    if ((ctx.store.getState().settings?.theme ?? 'dark') !== 'system') return;
    applyFromState(ctx);
    updateThemeIcons(effectiveTheme(ctx));
  };
  mq.addEventListener?.('change', handler);
  return () => mq.removeEventListener?.('change', handler);
}

/** @param {any} ctx @param {Record<string, unknown>} patch */
async function patchAndSave(ctx, patch) {
  ctx.store.dispatch({ type: A.SETTINGS_PATCHED, patch });
  await saveAll(ctx);
}

/** Persiste el snapshot completo de settings del store. @param {any} ctx */
async function saveAll(ctx) {
  const s = ctx.store.getState().settings ?? {};
  await ctx.repo.saveSettings({ ...s });
}

/** @param {any} ctx @param {string} field @param {number} value */
function announce(ctx, field, value) {
  switch (field) {
    case 'autoSaveMinutes':
      showToast(ctx, value > 0 ? `Auto-save every ${value}m` : 'Auto-save off', 'success');
      break;
    case 'minAutoSaveTabs':
      showToast(ctx, `Auto-save minimum: ${value} tabs`, 'success');
      break;
    case 'trashPurgeDays':
      showToast(ctx, `Trash purge: ${value} days`, 'success');
      break;
    case 'dupThreshold':
      showToast(ctx, `Duplicate warning at ${value}% similarity`, 'success');
      break;
    default:
      break;
  }
}

/** @param {any} ctx @param {string} field @param {boolean} on */
function announceToggle(ctx, field, on) {
  /** @type {Record<string, string>} */
  const messages = {
    autoSaveOnClose: on ? 'Auto-save on close enabled' : 'Auto-save on close disabled',
    includeIncognito: on ? 'Incognito windows included' : 'Incognito windows excluded',
    dedupeOnRestore: on ? 'Focus existing tabs on restore' : 'Always open new tabs',
    dedupeOnSave: on ? 'Duplicate tabs will be merged when saving' : 'Tabs saved exactly as captured',
    syncEnabled: on ? 'Sync enabled' : 'Sync disabled',
    newTabEnabled: on ? 'New-tab page enabled (TabVault)' : 'New-tab page disabled',
    historyEnabled: on ? 'History in search enabled' : 'History in search disabled',
  };
  showToast(ctx, messages[field] ?? '', 'success');
}
