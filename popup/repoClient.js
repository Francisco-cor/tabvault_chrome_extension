// popup/repoClient.js — Fachada del repositorio para el popup/side panel.
//
// ADR-0002 (single-writer): las LECTURAS se sirven localmente (caché coherente vía
// onChanged); las ESCRITURAS se enrutan al service worker por mensaje REPO_OP.
// La respuesta confirma el resultado; la caché local se refresca sola por el mismo
// evento onChanged que dispara la escritura del SW.

import { Repository, REMOTE_OPS } from '../core/repository.js';
import { newId } from '../core/domain.js';
import { MSG, sendToBackground } from '../shared/messages.js';

/** Repositorio local de SOLO LECTURA (lecturas instantáneas, cero round-trip). */
const local = new Repository({ writable: false });
local.attach();

/**
 * Ejecuta una operación de escritura en el service worker.
 * @template T
 * @param {string} op
 * @param {unknown[]} args
 * @returns {Promise<T>}
 */
async function remote(op, args) {
  const res = await sendToBackground({ type: MSG.REPO_OP, op, args });
  if (!res.ok) throw new Error(res.error ?? `REPO_OP ${op} failed`);
  return /** @type {T} */ (res.data);
}

/** Métodos de lectura delegados al repo local. */
const reads = {
  getSessions: () => local.getSessions(),
  getSession: (/** @type {string} */ id) => local.getSession(id),
  getTrash: () => local.getTrash(),
  getVersions: (/** @type {string} */ id) => local.getVersions(id),
  getSettings: () => local.getSettings(),
  loadSyncSettings: () => local.loadSyncSettings(),
  getUsagePercent: () => local.getUsagePercent(),
  exportAll: () => local.exportAll(),
  exportSession: (/** @type {string} */ id) => local.exportSession(id),
  getBackups: () => local.getBackups(),
  getRoutines: () => local.getRoutines(),
  getAutoTagRules: () => local.getAutoTagRules(),
  getFavicons: () => local.getFavicons(),
};

/** Métodos de escritura enrutados al SW; devuelven la entidad resultante. */
const writes = Object.fromEntries(
  [...REMOTE_OPS].map((op) => [
    op,
    /** @param {...any} args */
    async (...args) => {
      const data = await remote(op, args);
      // refresco determinista de la vista aunque onChanged aún no haya corrido
      if (
        [
          'saveSession',
          'updateSession',
          'mergeSessions',
          'restoreVersion',
          'importAll',
          'restoreBackup',
        ].includes(op)
      ) {
        local.invalidate();
      }
      return data;
    },
  ])
);

/**
 * Fachada completa: lecturas tipadas + escrituras dinámicas desde REMOTE_OPS
 * (saveSession, updateSession, saveSettings, deleteSession, …).
 *
 * @typedef {typeof reads & {
 *   [op: string]: any,
 *   generateId: () => string,
 *   invalidate: () => void,
 *   subscribe: (fn: (area: string) => void) => void,
 * }} RepoFacade
 */

/** @type {RepoFacade} */
export const repo = {
  ...reads,
  ...writes,
  /** Genera un id (mismo contrato que el antiguo StorageManager.generateId). */
  generateId: () => newId(),
  /** Invalida la caché local (escape manual). */
  invalidate: () => local.invalidate(),
  /** Suscripción a cambios (para el store de Fase 4). */
  subscribe: (/** @type {(area: string) => void} */ fn) => local.subscribe(fn),
};
