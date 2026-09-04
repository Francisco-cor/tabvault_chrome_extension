// shared/messages.js — Contrato único de mensajería popup ↔ service worker
// Un solo mapa para eliminar strings mágicos y tipar el protocolo.

export const MSG = Object.freeze({
  CAPTURE_SESSION: 'CAPTURE_SESSION',
  CAPTURE_ALL_WINDOWS: 'CAPTURE_ALL_WINDOWS',
  RESTORE_SESSION: 'RESTORE_SESSION',
  REPLACE_WINDOW_WITH_SESSION: 'REPLACE_WINDOW_WITH_SESSION',
  STASH_TAB: 'STASH_TAB', // stash rápido de una tab (Fase 6)
  /** Guarda UN grupo vivo como sesión individual (Fase 7.6) */
  SAVE_GROUP_AS_SESSION: 'SAVE_GROUP_AS_SESSION',
  GET_STATS: 'GET_STATS',
  REFRESH_ALARM: 'REFRESH_ALARM',
  CONVERT_FAVICON: 'CONVERT_FAVICON',
  /** Operación genérica de escritura del repositorio { op, args } (ADR-0002) */
  REPO_OP: 'REPO_OP',
  // Fase 9: productividad
  FOCUS_SESSION: 'FOCUS_SESSION',
  SUSPEND_TABS: 'SUSPEND_TABS',
  SEARCH_HISTORY: 'SEARCH_HISTORY',
});

/**
 * Respuesta uniforme de todo handler del SW.
 *
 * @template T
 * @typedef {Object} Response
 * @property {true} ok
 * @property {T} [data]
 */
/**
 * @typedef {Object} ErrorResponse
 * @property {false} ok
 * @property {string} error
 */
/** @template T @typedef {Response<T>|ErrorResponse} Result<T> */

/**
 * Envia un mensaje al SW y normaliza la respuesta.
 * Envolver aquí permite añadir timeouts/reintentos sin tocar los llamadores.
 *
 * @template T
 * @param {{ type: string, [k: string]: unknown }} message
 * @returns {Promise<Result<T>>}
 */
export async function sendToBackground(message) {
  try {
    const res = await chrome.runtime.sendMessage(message);
    return res ?? { ok: false, error: 'Empty response from background' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Background unreachable';
    return { ok: false, error: msg };
  }
}
