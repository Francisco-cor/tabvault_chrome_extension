// core/repository.js — Única capa de persistencia (reemplaza a shared/storage.js).
//
// Garantías:
//  1. SERIALIZACIÓN: toda mutación pasa por una cola FIFO (_enqueue) → sin RMW solapados.
//  2. FRESCURA: cada mutación lee estado recién traído de chrome.storage (nunca confía en caché).
//  3. COHERENCIA: suscripción a storage.onChanged invalida cachés en AMBOS contextos → muere el bug C2.
//  4. VALIDACIÓN: entradas se normalizan/validan (schema.js); salida siempre saneada.
//  5. SINGLE-WRITER (ADR-0002): solo el service worker instancia con {writable:true};
//     el popup usa popup/repoClient.js que enruta escrituras por mensajes.

import {
  normalizeSession,
  normalizeTab,
  normalizeSettings,
  normalizeRoutines,
  normalizeAutoTagRules,
  validateImportPayload,
  LIMITS,
} from './schema.js';
import { newId, computeMetadata, cloneCleanSession, mergeSessionsInto, reattachFavicons } from './domain.js';
import { renameTagEverywhere, deleteTagEverywhere, applyManualOrder } from './organization.js';
import { SCHEMA_VERSION, migrateIfNeeded } from './migrations.js';
import {
  buildBackupEntry,
  pushBackup,
  findBackup as findBackupInRings,
  ringOf,
  hasVaultData,
  EMPTY_RINGS,
} from './backups.js';
import { normalizeFaviconStore, rememberFavicons as rememberFaviconsIn } from './favicons.js';

/** @typedef {import('../shared/types.js').Session} Session */
/** @typedef {import('../shared/types.js').SessionMap} SessionMap */
/** @typedef {import('../shared/types.js').TrashMap} TrashMap */
/** @typedef {import('../shared/types.js').SnapshotEntry} SnapshotEntry */
/** @typedef {import('../shared/types.js').Settings} Settings */

/** Operaciones enrutables vía mensaje REPO_OP (whitelist). @type {Set<string>} */
export const REMOTE_OPS = new Set([
  'saveSession',
  'updateSession',
  'deleteSession',
  'deleteSessions',
  'togglePin',
  'mergeSessions',
  'saveVersion',
  'restoreVersion',
  'reorderTabs',
  'reorderGroups',
  'moveTabToGroup',
  'removeTabFromSession',
  'removeGroupFromSession',
  'addTabToSession',
  'restoreFromTrash',
  'deletePermanently',
  'purgeOldTrash',
  'saveSettings',
  'importAll',
  // Fase 7: organización (tags globales, orden manual)
  'setSessionTags',
  'setTabTags',
  'renameTag',
  'deleteTag',
  'setSessionOrder',
  // Fase 8: respaldos
  'createBackup',
  'restoreBackup',
  'deleteBackup',
  // Fase 9: rutinas + reglas
  'saveRoutine',
  'deleteRoutine',
  'toggleRoutine',
  'saveAutoTagRule',
  'deleteAutoTagRule',
  'setAutoTagRules',
]);

/** Error al mutar desde contexto read-only. */
class ReadOnlyError extends Error {
  /** @param {string} op */
  constructor(op) {
    super(`"${op}" requiere contexto writable (service worker). Usa popup/repoClient.js`);
    this.name = 'ReadOnlyError';
  }
}

/**
 * Inserta una tab en una lista respetando índice destino (clampeado a [0, len]).
 * @param {import('../shared/types.js').TabItem[]} list
 * @param {import('../shared/types.js').TabItem} tab
 * @param {number|null} [index]
 */
function insertTabAt(list, tab, index = null) {
  if (index == null || !Number.isFinite(index)) {
    list.push(tab);
    return;
  }
  const i = Math.max(0, Math.min(Math.trunc(index), list.length));
  list.splice(i, 0, tab);
}

export class Repository {
  /** @param {{ writable?: boolean }} [opts] */
  constructor({ writable = false } = {}) {
    this.writable = writable;
    /** @type {Promise<unknown>} cola serial de escritura */
    this._queue = Promise.resolve();
    /** @type {SessionMap|null} */
    this._sessions = null;
    /** @type {TrashMap|null} */
    this._trash = null;
    /** @type {Record<string, SnapshotEntry[]>|null} */
    this._versions = null;
    /** @type {Settings|null} */
    this._settings = null;
    /** @type {{ daily: import('./backups.js').BackupEntry[], event: import('./backups.js').BackupEntry[] }|null} */
    this._backups = null;
    /** @type {import('../shared/types.js').Routine[]|null} */
    this._routines = null;
    /** @type {import('../shared/types.js').AutoTagRule[]|null} */
    this._autoTagRules = null;
    /** @type {import('./favicons.js').FaviconStore|null} */
    this._favicons = null;
    /** @type {((area: string) => void)[]} */
    this._listeners = [];
    /** @type {(() => void)|null} */
    this._detach = null;
  }

  // ─── Infraestructura ─────────────────────────────────────────────────────────

  /** Suscribe a cambios externos (coherencia multi-contexto). @returns {() => void} detach */
  attach() {
    if (this._detach) return this._detach;
    /** @param {Record<string, chrome.storage.StorageChange>} changes @param {string} area */
    const listener = (changes, area) => {
      if (area !== 'local') return;
      const touched = [];
      if ('sessions' in changes) ((this._sessions = null), touched.push('sessions'));
      if ('trash' in changes) ((this._trash = null), touched.push('trash'));
      if ('versions' in changes) ((this._versions = null), touched.push('versions'));
      if ('settings' in changes || 'meta' in changes) ((this._settings = null), touched.push('settings'));
      if ('backups' in changes) ((this._backups = null), touched.push('backups'));
      if ('routines' in changes) ((this._routines = null), touched.push('routines'));
      if ('autoTagRules' in changes) ((this._autoTagRules = null), touched.push('autoTagRules'));
      if ('favicons' in changes) ((this._favicons = null), touched.push('favicons'));
      for (const t of touched) this._notify(t);
    };
    chrome.storage.onChanged.addListener(listener);
    this._detach = () => chrome.storage.onChanged.removeListener(listener);
    return this._detach;
  }

  /** @param {(area: string) => void} fn @returns {() => void} unsubscribe */
  subscribe(fn) {
    this._listeners.push(fn);
    return () => {
      const i = this._listeners.indexOf(fn);
      if (i !== -1) this._listeners.splice(i, 1);
    };
  }

  /** @private @param {string} area */
  _notify(area) {
    for (const fn of this._listeners) {
      try {
        fn(area);
      } catch {
        /* listener defectuoso no rompe al resto */
      }
    }
  }

  invalidate() {
    this._sessions = null;
    this._trash = null;
    this._versions = null;
    this._settings = null;
    this._backups = null;
    this._routines = null;
    this._autoTagRules = null;
    this._favicons = null;
  }

  /**
   * Serializa mutaciones. La promesa devuelta refleja éxito/fallo de ESTA operación;
   * la cadena global continúa aunque una operación falle.
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   * @protected
   */
  _enqueue(fn) {
    const run = /** @type {Promise<T>} */ (this._queue.then(fn));
    this._queue = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  /** @private @param {string} op */
  _assertWritable(op) {
    if (!this.writable) throw new ReadOnlyError(op);
  }

  /** @private Lectura cruda para RMW frescos dentro de la cola. @param {string} key @returns {Promise<any>} */
  async _getFresh(key) {
    return /** @type {any} */ ((await chrome.storage.local.get(key)) ?? {})[key];
  }

  /** @private Normaliza el mapa completo una sola vez al llenar cache. @param {unknown} raw @returns {SessionMap} */
  _normalizeSessionMap(raw) {
    /** @type {SessionMap} */
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const [id, value] of Object.entries(raw)) {
      const norm = normalizeSession(value);
      if (norm) out[norm.id] = norm;
    }
    return out;
  }

  /** @private Escribe sesiones + actualiza cache write-through + notifica. @param {SessionMap} sessions */
  async _writeSessions(sessions) {
    await chrome.storage.local.set({ sessions });
    this._sessions = sessions;
    this._notify('sessions');
  }

  // ─── Migraciones ─────────────────────────────────────────────────────────────

  /**
   * Ejecuta migrateIfNeeded contra chrome.storage real e invalida cachés.
   * Llamar en arranque de SW y popup (es barato si ya está migrado).
   * @param {(m: string) => void} [log]
   */
  async runMigrations(log = () => {}) {
    /** @type {{ get: (k: any) => Promise<any>, set: (o: object) => Promise<void> }} */
    const adapter = {
      get: (keys) => chrome.storage.local.get(keys),
      set: (obj) => chrome.storage.local.set(obj),
    };
    const res = await migrateIfNeeded(adapter, log);
    this.invalidate();
    return res;
  }

  // ─── Sessions: lectura ───────────────────────────────────────────────────────

  /** @returns {Promise<SessionMap>} */
  async getSessions() {
    if (this._sessions) return this._sessions;
    const raw = await this._getFresh('sessions');
    this._sessions = this._normalizeSessionMap(raw);
    return this._sessions;
  }

  /**
   * @param {string} id
   * @returns {Promise<Session|null>}
   */
  async getSession(id) {
    const sessions = await this.getSessions();
    return sessions[id] ?? null;
  }

  // ─── Sessions: escritura ─────────────────────────────────────────────────────

  /**
   * @param {Session} session
   * @returns {Promise<Session>} sesión normalizada tal como quedó almacenada
   */
  saveSession(session) {
    this._assertWritable('saveSession');
    return this._enqueue(async () => {
      const sessions = this._normalizeSessionMap(await this._getFresh('sessions'));
      const norm = normalizeSession({ ...session, id: session.id || newId() });
      if (!norm) throw new Error('Invalid session payload');
      sessions[norm.id] = { ...norm, updated: Date.now() };
      await this._writeSessions(sessions);
      return sessions[norm.id];
    });
  }

  /**
   * @param {string} id
   * @param {Partial<Session>} patch
   * @returns {Promise<Session>}
   */
  updateSession(id, patch) {
    this._assertWritable('updateSession');
    return this._enqueue(async () => {
      const sessions = this._normalizeSessionMap(await this._getFresh('sessions'));
      if (!sessions[id]) throw new Error(`Session ${id} not found`);
      const norm = normalizeSession({ ...sessions[id], ...patch, id });
      if (!norm) throw new Error(`Patch produced an invalid session (${id})`);
      sessions[id] = { ...norm, updated: Date.now() };
      await this._writeSessions(sessions);
      return sessions[id];
    });
  }

  /** Soft-delete → papelera. @param {string} id */
  deleteSession(id) {
    this._assertWritable('deleteSession');
    return this._enqueue(async () => {
      const sessions = this._normalizeSessionMap(await this._getFresh('sessions'));
      const session = sessions[id];
      if (!session) return;
      delete sessions[id];
      const trash = (await this._getFresh('trash')) ?? {};
      trash[id] = { ...session, deletedAt: Date.now() };
      await chrome.storage.local.set({ sessions, trash });
      this._sessions = sessions;
      this._trash = trash;
      this._notify('sessions');
      this._notify('trash');
    });
  }

  /** Bulk soft-delete. @param {string[]} ids */
  deleteSessions(ids) {
    this._assertWritable('deleteSessions');
    return this._enqueue(async () => {
      const sessions = this._normalizeSessionMap(await this._getFresh('sessions'));
      const trash = (await this._getFresh('trash')) ?? {};
      for (const id of ids) {
        const session = sessions[id];
        if (!session) continue;
        delete sessions[id];
        trash[id] = { ...session, deletedAt: Date.now() };
      }
      await chrome.storage.local.set({ sessions, trash });
      this._sessions = sessions;
      this._trash = trash;
      this._notify('sessions');
      this._notify('trash');
      return { sessions, trash };
    });
  }

  /** @param {string} id @returns {Promise<boolean>} nuevo estado pinned */
  togglePin(id) {
    this._assertWritable('togglePin');
    return this._enqueue(async () => {
      const sessions = this._normalizeSessionMap(await this._getFresh('sessions'));
      if (!sessions[id]) return false;
      sessions[id].pinned = !sessions[id].pinned;
      sessions[id].updated = Date.now();
      await this._writeSessions(sessions);
      return sessions[id].pinned;
    });
  }

  /**
   * Combina sesiones existentes en una nueva (ids regenerados, originales intactos).
   * @param {string[]} sourceIds
   * @param {string} newName
   */
  mergeSessions(sourceIds, newName) {
    this._assertWritable('mergeSessions');
    return this._enqueue(async () => {
      const sessions = this._normalizeSessionMap(await this._getFresh('sessions'));
      const sources = sourceIds.map((id) => sessions[id]).filter(Boolean);
      const merged = normalizeSession(mergeSessionsInto(sources, newName));
      if (!merged) throw new Error('Merge produced an invalid session');
      sessions[merged.id] = merged;
      await this._writeSessions(sessions);
      return merged;
    });
  }

  // ─── Edición estructural ─────────────────────────────────────────────────────

  /**
   * Reordena tabs dentro de un grupo o de ungrouped. Fuera de rango → no-op (undefined).
   * @param {string} sessionId
   * @param {string|null} groupId
   * @param {number} fromIndex
   * @param {number} toIndex
   */
  reorderTabs(sessionId, groupId, fromIndex, toIndex) {
    this._assertWritable('reorderTabs');
    return this._enqueue(async () => {
      const sessions = this._normalizeSessionMap(await this._getFresh('sessions'));
      const session = sessions[sessionId];
      if (!session) return undefined;

      const tabs = groupId
        ? (session.groups?.find((g) => g.id === groupId)?.tabs ?? [])
        : (session.ungroupedTabs ?? []);
      if (fromIndex < 0 || fromIndex >= tabs.length || toIndex < 0 || toIndex >= tabs.length) {
        return undefined;
      }
      const [moved] = tabs.splice(fromIndex, 1);
      tabs.splice(toIndex, 0, moved);

      session.metadata = computeMetadata(session);
      session.updated = Date.now();
      await this._writeSessions(sessions);
      return session;
    });
  }

  /**
   * @param {string} sessionId
   * @param {number} fromIndex
   * @param {number} toIndex
   */
  reorderGroups(sessionId, fromIndex, toIndex) {
    this._assertWritable('reorderGroups');
    return this._enqueue(async () => {
      const sessions = this._normalizeSessionMap(await this._getFresh('sessions'));
      const session = sessions[sessionId];
      if (!session?.groups) return undefined;

      const groups = session.groups;
      if (fromIndex < 0 || fromIndex >= groups.length || toIndex < 0 || toIndex >= groups.length) {
        return undefined;
      }
      const [moved] = groups.splice(fromIndex, 1);
      groups.splice(toIndex, 0, moved);

      session.updated = Date.now();
      await this._writeSessions(sessions);
      return session;
    });
  }

  /**
   * Mueve tab entre grupos/ungrouped; elimina grupo fuente si queda vacío.
   * `toIndex` (opcional) inserta en esa posición del destino (clampeada);
   * por defecto va al final. Fix M14: el drop cross-group respeta el índice destino.
   * @param {string} sessionId
   * @param {string} tabId
   * @param {string|null} fromGroupId
   * @param {string|null} toGroupId
   * @param {number|null} [toIndex]
   */
  moveTabToGroup(sessionId, tabId, fromGroupId, toGroupId, toIndex = null) {
    this._assertWritable('moveTabToGroup');
    return this._enqueue(async () => {
      const sessions = this._normalizeSessionMap(await this._getFresh('sessions'));
      const session = sessions[sessionId];
      if (!session) return undefined;

      /** @type {import('../shared/types.js').TabItem|null} */
      let tab = null;
      if (fromGroupId) {
        const srcGroup = session.groups?.find((g) => g.id === fromGroupId);
        if (srcGroup) {
          const idx = srcGroup.tabs.findIndex((t) => t.id === tabId);
          if (idx !== -1) [tab] = srcGroup.tabs.splice(idx, 1);
          if (srcGroup.tabs.length === 0) {
            session.groups = session.groups.filter((g) => g.id !== fromGroupId);
          }
        }
      } else {
        const idx = (session.ungroupedTabs ?? []).findIndex((t) => t.id === tabId);
        if (idx !== -1) [tab] = session.ungroupedTabs.splice(idx, 1);
      }
      if (!tab) return undefined;

      if (toGroupId) {
        const dest = session.groups?.find((g) => g.id === toGroupId);
        if (!dest) return undefined; // destino inexistente: sin pérdida silenciosa
        insertTabAt(dest.tabs, tab, toIndex);
      } else {
        session.ungroupedTabs = session.ungroupedTabs ?? [];
        insertTabAt(session.ungroupedTabs, tab, toIndex);
      }

      session.metadata = computeMetadata(session);
      session.updated = Date.now();
      await this._writeSessions(sessions);
      return session;
    });
  }

  /**
   * @param {string} sessionId
   * @param {string|null} groupId
   * @param {string} tabId
   */
  removeTabFromSession(sessionId, groupId, tabId) {
    this._assertWritable('removeTabFromSession');
    return this._enqueue(async () => {
      const sessions = this._normalizeSessionMap(await this._getFresh('sessions'));
      const session = sessions[sessionId];
      if (!session) throw new Error('Session not found');

      if (groupId) {
        const group = session.groups?.find((g) => g.id === groupId);
        if (group) group.tabs = group.tabs.filter((t) => t.id !== tabId);
        session.groups = (session.groups ?? []).filter((g) => g.tabs.length > 0);
      } else {
        session.ungroupedTabs = (session.ungroupedTabs ?? []).filter((t) => t.id !== tabId);
      }

      session.metadata = computeMetadata(session);
      session.updated = Date.now();
      await this._writeSessions(sessions);
      return session;
    });
  }

  /** @param {string} sessionId @param {string} groupId */
  removeGroupFromSession(sessionId, groupId) {
    this._assertWritable('removeGroupFromSession');
    return this._enqueue(async () => {
      const sessions = this._normalizeSessionMap(await this._getFresh('sessions'));
      const session = sessions[sessionId];
      if (!session) throw new Error('Session not found');

      session.groups = (session.groups ?? []).filter((g) => g.id !== groupId);
      session.metadata = computeMetadata(session);
      session.updated = Date.now();
      await this._writeSessions(sessions);
      return session;
    });
  }

  /**
   * Añade tab a ungroupedTabs. Rechaza payloads sin URL segura.
   * @param {string} sessionId
   * @param {import('../shared/types.js').TabItem} tabData
   */
  addTabToSession(sessionId, tabData) {
    this._assertWritable('addTabToSession');
    return this._enqueue(async () => {
      const sessions = this._normalizeSessionMap(await this._getFresh('sessions'));
      const session = sessions[sessionId];
      if (!session) throw new Error('Session not found');

      const tab = normalizeTab(tabData);
      if (!tab) throw new Error('Invalid tab: URL missing or unsafe');

      session.ungroupedTabs = session.ungroupedTabs ?? [];
      session.ungroupedTabs.push(tab);
      session.metadata = computeMetadata(session);
      session.updated = Date.now();
      await this._writeSessions(sessions);
      return session;
    });
  }

  // ─── Organización (Fase 7): tags globales y orden manual ────────────────────

  /**
   * Reemplaza las tags de NIVEL SESIÓN. Normalizadas por schema al persistir.
   * @param {string} sessionId @param {string[]} tags
   */
  setSessionTags(sessionId, tags) {
    this._assertWritable('setSessionTags');
    return this.updateSession(sessionId, { tags });
  }

  /**
   * Reemplaza las tags de UNA tab (grupo o ungrouped). Fix del nivel tab (7.3).
   * @param {string} sessionId @param {string|null} groupId @param {string} tabId @param {string[]} tags
   */
  setTabTags(sessionId, groupId, tabId, tags) {
    this._assertWritable('setTabTags');
    return this._enqueue(async () => {
      const sessions = this._normalizeSessionMap(await this._getFresh('sessions'));
      const session = sessions[sessionId];
      if (!session) throw new Error('Session not found');

      const list = groupId
        ? (session.groups?.find((g) => g.id === groupId)?.tabs ?? [])
        : (session.ungroupedTabs ?? []);
      const tab = list.find((t) => t.id === tabId);
      if (!tab) throw new Error('Tab not found');

      tab.tags = (Array.isArray(tags) ? tags : [])
        .map((t) =>
          String(t ?? '')
            .slice(0, 40)
            .trim()
        )
        .filter(Boolean)
        .slice(0, 24);

      session.updated = Date.now();
      await this._writeSessions(sessions);
      return session;
    });
  }

  /**
   * Renombra/fusiona una tag en sesiones+grupos+tabs de una vez.
   * @param {string} from @param {string} to @returns {Promise<{entities: number}>}
   */
  async renameTag(from, to) {
    this._assertWritable('renameTag');
    return this._enqueue(async () => {
      const fresh = this._normalizeSessionMap(await this._getFresh('sessions'));
      const { sessions: next, entities } = renameTagEverywhere(fresh, from, to);
      if (entities > 0) {
        // Bump de updated para que el índice de búsqueda sincronice incrementalmente.
        const now = Date.now();
        for (const s of Object.values(next)) {
          if (s !== fresh[s.id]) s.updated = now;
        }
        await this._writeSessions(next);
      }
      return { entities };
    });
  }

  /**
   * Borra una tag en todos los niveles. @param {string} tag @returns {Promise<{entities: number}>}
   */
  async deleteTag(tag) {
    this._assertWritable('deleteTag');
    return this._enqueue(async () => {
      const fresh = this._normalizeSessionMap(await this._getFresh('sessions'));
      const { sessions: next, entities } = deleteTagEverywhere(fresh, tag);
      if (entities > 0) {
        const now = Date.now();
        for (const s of Object.values(next)) {
          if (s !== fresh[s.id]) s.updated = now;
        }
        await this._writeSessions(next);
      }
      return { entities };
    });
  }

  /**
   * Orden manual persistente: asigna `order` secuencial (1-based) a la lista
   * completa visualizada. Las sesiones ausentes quedan sin order (al final).
   * CRITERIO Fase 7: sobrevive cierre/reapertura del popup Y del navegador.
   * @param {string[]} orderedIds ids en el orden visual final
   */
  async setSessionOrder(orderedIds) {
    this._assertWritable('setSessionOrder');
    return this._enqueue(async () => {
      const sessions = this._normalizeSessionMap(await this._getFresh('sessions'));
      const orders = applyManualOrder(
        /** @type {string[]} */ ((Array.isArray(orderedIds) ? orderedIds : []).filter((id) => !!sessions[id]))
      );
      for (const [id, order] of Object.entries(orders)) {
        sessions[id].order = order;
      }
      // Las que salieron de la lista (borradas mientras tanto) no se tocan;
      // las presentes sin order explícito quedan después de las ordenadas.
      await this._writeSessions(sessions);
      return orders;
    });
  }

  // ─── Versionado ──────────────────────────────────────────────────────────────
  /**
   * Snapshot limpio (sin campos internos ni favicons — ahorro de espacio).
   * @param {string} sessionId
   */
  saveVersion(sessionId) {
    this._assertWritable('saveVersion');
    return this._enqueue(async () => {
      const sessions = this._normalizeSessionMap(await this._getFresh('sessions'));
      const session = sessions[sessionId];
      if (!session) return;

      const versions = (await this._getFresh('versions')) ?? {};
      const list = versions[sessionId] ?? [];

      const clean = cloneCleanSession(session);
      for (const g of clean.groups ?? []) for (const t of g.tabs ?? []) t.favicon = '';
      for (const t of clean.ungroupedTabs ?? []) t.favicon = '';

      list.unshift({ snapshot: clean, savedAt: Date.now() });
      if (list.length > 5) list.length = 5;

      versions[sessionId] = list;
      await chrome.storage.local.set({ versions });
      this._versions = versions;
      this._notify('versions');
    });
  }

  /** @param {string} sessionId @returns {Promise<SnapshotEntry[]>} */
  async getVersions(sessionId) {
    /** @type {Record<string, SnapshotEntry[]>} */
    const versions = this._versions ?? (await this._getFresh('versions')) ?? {};
    this._versions = versions;
    return versions[sessionId] ?? [];
  }

  /**
   * Restaura versión. El estado previo se versiona primero; los favicons del
   * estado ACTUAL se re-adjuntan al snapshot (que fue persistido sin ellos).
   * FIX: ya no se pierden favicons para nunca tras restaurar.
   * @param {string} sessionId
   * @param {number} versionIndex
   */
  restoreVersion(sessionId, versionIndex) {
    this._assertWritable('restoreVersion');
    return this._enqueue(async () => {
      const versions = (await this._getFresh('versions')) ?? {};
      const entry = (versions[sessionId] ?? [])[versionIndex];
      if (!entry) throw new Error('Version not found');

      const sessions = this._normalizeSessionMap(await this._getFresh('sessions'));
      const current = sessions[sessionId];

      if (current) {
        // guarda estado previo como nueva versión (sin contar en la lista leída arriba)
        const clean = cloneCleanSession(current);
        for (const g of clean.groups ?? []) for (const t of g.tabs ?? []) t.favicon = '';
        for (const t of clean.ungroupedTabs ?? []) t.favicon = '';
        versions[sessionId] = [{ snapshot: clean, savedAt: Date.now() }, ...(versions[sessionId] ?? [])];
        if (versions[sessionId].length > 5) versions[sessionId].length = 5;
      }

      const restored = normalizeSession({
        ...entry.snapshot,
        id: sessionId,
        updated: Date.now(),
      });
      if (!restored) throw new Error('Stored snapshot is invalid');
      reattachFavicons(restored, current ?? null);

      sessions[sessionId] = restored;
      await chrome.storage.local.set({ sessions, versions });
      this._sessions = sessions;
      this._versions = versions;
      this._notify('sessions');
      this._notify('versions');
      return restored;
    });
  }

  // ─── Papelera ────────────────────────────────────────────────────────────────

  /** @returns {Promise<TrashMap>} */
  async getTrash() {
    if (this._trash) return this._trash;
    const raw = await this._getFresh('trash');
    /** @type {TrashMap} */
    const out = {};
    if (raw && typeof raw === 'object') {
      for (const [id, value] of Object.entries(raw)) {
        const norm = normalizeSession(value);
        const deletedAt = /** @type {any} */ (value)?.deletedAt;
        if (norm && typeof deletedAt === 'number') out[norm.id] = { ...norm, deletedAt };
      }
    }
    this._trash = out;
    return out;
  }

  /** @param {string} id */
  restoreFromTrash(id) {
    this._assertWritable('restoreFromTrash');
    return this._enqueue(async () => {
      const trash = (await this._getFresh('trash')) ?? {};
      const entry = trash[id];
      if (!entry) throw new Error('Not in trash');
      delete trash[id];

      const sessions = this._normalizeSessionMap(await this._getFresh('sessions'));
      const restored = normalizeSession(entry);
      if (!restored) throw new Error('Trashed entry is invalid');
      sessions[restored.id] = { ...restored, updated: Date.now() };

      await chrome.storage.local.set({ sessions, trash });
      this._sessions = sessions;
      this._trash = trash;
      this._notify('sessions');
      this._notify('trash');
      return sessions[restored.id];
    });
  }

  /** Borra definitivamente y limpia versiones huérfanas. @param {string} id */
  deletePermanently(id) {
    this._assertWritable('deletePermanently');
    return this._enqueue(async () => {
      const trash = (await this._getFresh('trash')) ?? {};
      delete trash[id];
      const versions = (await this._getFresh('versions')) ?? {};
      if (versions[id]) delete versions[id];
      await chrome.storage.local.set({ trash, versions });
      this._trash = trash;
      this._versions = versions;
      this._notify('trash');
      this._notify('versions');
    });
  }

  /**
   * Purga papelera más vieja que `days`. Sin argumento usa settings.trashPurgeDays.
   * Ejecutada por alarm diaria en el SW (fix C10: ya no depende de abrir el popup).
   * @param {number} [days]
   */
  purgeOldTrash(days) {
    this._assertWritable('purgeOldTrash');
    return this._enqueue(async () => {
      const d =
        typeof days === 'number'
          ? days
          : (normalizeSettings(await this._getFresh('settings')).trashPurgeDays ?? 30);
      const trash = (await this._getFresh('trash')) ?? {};
      const cutoff = Date.now() - d * 86_400_000;
      let changed = false;
      for (const [id, entry] of Object.entries(trash)) {
        if (/** @type {any} */ (entry).deletedAt < cutoff) {
          delete trash[id];
          changed = true;
        }
      }
      if (changed) {
        await chrome.storage.local.set({ trash });
        this._trash = trash;
        this._notify('trash');
      }
      return changed;
    });
  }

  // ─── Settings ────────────────────────────────────────────────────────────────

  /** @returns {Promise<Settings>} */
  async getSettings() {
    if (this._settings) return this._settings;
    this._settings = normalizeSettings(await this._getFresh('settings'));
    return this._settings;
  }

  /** @param {Partial<Settings>} settings */
  saveSettings(settings) {
    this._assertWritable('saveSettings');
    return this._enqueue(async () => {
      const current = await this.getSettings();
      const norm = normalizeSettings({ ...current, ...settings });
      await chrome.storage.local.set({ settings: norm });
      if (norm.syncEnabled) {
        try {
          await chrome.storage.sync.set({ settings: norm });
        } catch {
          /* sync puede no estar disponible */
        }
      }
      this._settings = norm;
      this._notify('settings');
      return norm;
    });
  }

  /** Preferencias desde chrome.storage.sync (si syncEnabled). @returns {Promise<Settings|null>} */
  async loadSyncSettings() {
    try {
      const r = await chrome.storage.sync.get('settings');
      return r.settings ? normalizeSettings(r.settings) : null;
    } catch {
      return null;
    }
  }

  // ─── Cuota ───────────────────────────────────────────────────────────────────

  /** @returns {Promise<number>} % de la cuota base (informativo; unlimitedStorage lo amplía) */
  async getUsagePercent() {
    const quota = chrome.storage.local.QUOTA_BYTES;
    if (!quota) return 0;
    const used = await chrome.storage.local.getBytesInUse(null);
    return Math.round((used / quota) * 100);
  }

  // ─── Export / Import (Fase 8) ────────────────────────────────────────────────

  /** Backup completo como JSON (excluye backups propios y legacy). */
  async exportAll() {
    const all = await chrome.storage.local.get(null);
    const clean = Object.fromEntries(
      Object.entries(all).filter(([k]) => !k.startsWith('backup_') && k !== 'backups')
    );
    return JSON.stringify({ _tabvault: true, version: SCHEMA_VERSION, ...clean }, null, 2);
  }

  /** @param {string} id */
  async exportSession(id) {
    const session = await this.getSession(id);
    if (!session) throw new Error('Session not found');
    return JSON.stringify({ _tabvault: true, version: SCHEMA_VERSION, session }, null, 2);
  }

  /**
   * Import VALIDADO (fix C7). Crea SIEMPRE un backup 'pre-import' antes de
   * escribir (Fase 8.1): cualquier import es reversible.
   *
   * Modos:
   *  - 'replace': sustituye todo el contenido importable.
   *  - 'merge'  : estrategias ante colisión de id (planImport las muestra en UI):
   *      'update'    → actualiza la existente preservando su estado del vault
   *                    (pinned/order/openCount/lastOpened/flags)
   *      'keep-both' → id nuevo para la entrante (nunca pisa)
   *  - skipIncomingIds: ids a omitir (checkbox "saltar similares" del preview).
   *
   * @param {string} jsonString
   * @param {{ mode?: 'replace'|'merge', strategy?: 'update'|'keep-both', skipIncomingIds?: string[] }} [opts]
   * @returns {Promise<{ imported: number, added: number, updated: number, skipped: number, errors: string[], mode: string }>}
   */
  importAll(jsonString, { mode = 'replace', strategy = 'keep-both', skipIncomingIds } = {}) {
    this._assertWritable('importAll');
    return this._enqueue(async () => {
      if (typeof jsonString !== 'string' || jsonString.length > LIMITS.IMPORT_CHARS) {
        throw new Error('File too large to import');
      }
      let data;
      try {
        data = JSON.parse(jsonString);
      } catch {
        throw new Error('Invalid JSON file');
      }
      const report = validateImportPayload(data);
      if (!report.ok) throw new Error(report.errors[0] ?? 'Not a valid TabVault export file');

      // Reversibilidad: snapshot ANTES de tocar nada.
      await this._snapshotNow('pre-import');

      if (mode === 'merge') {
        return this._importMerge(report, strategy, skipIncomingIds ?? []);
      }

      // replace
      const write = { ...report.value, meta: { schemaVersion: SCHEMA_VERSION } };
      await chrome.storage.local.remove(['sessions', 'trash', 'versions', 'settings']);
      await chrome.storage.local.set(write);
      this.invalidate();
      const imported = Object.keys(write.sessions ?? {}).length;
      return {
        imported,
        added: imported,
        updated: 0,
        skipped: 0,
        errors: report.errors,
        mode,
      };
    });
  }

  /**
   * Rama merge de importAll. @private
   * @param {ReturnType<typeof validateImportPayload>} report
   * @param {'update'|'keep-both'} strategy
   * @param {string[]} skipIds
   */
  async _importMerge(report, strategy, skipIds) {
    const sessions = this._normalizeSessionMap(await this._getFresh('sessions'));
    const trash = (await this._getFresh('trash')) ?? {};
    const versions = (await this._getFresh('versions')) ?? {};
    const skip = new Set(skipIds);

    let added = 0;
    let updated = 0;
    let skipped = 0;

    for (const incoming of Object.values(report.value.sessions ?? {})) {
      if (skip.has(incoming.id)) {
        skipped++;
        continue;
      }
      const existing = sessions[incoming.id];
      if (!existing) {
        sessions[incoming.id] = incoming;
        added++;
      } else if (strategy === 'update') {
        // Actualiza CONTENIDO; el estado local del vault (pins, orden, uso)
        // sobrevive — el archivo puede ser más viejo que este vault.
        const merged = normalizeSession({
          ...existing,
          name: incoming.name,
          created: incoming.created,
          groups: incoming.groups,
          ungroupedTabs: incoming.ungroupedTabs,
          tags: incoming.tags,
          metadata: incoming.metadata,
          autoSaved: existing.autoSaved,
          isTemplate: existing.isTemplate,
          stash: existing.stash,
        });
        if (merged) {
          sessions[incoming.id] = { ...merged, updated: Date.now() };
          updated++;
        }
      } else {
        const copy = /** @type {any} */ ({ ...incoming, id: newId() });
        sessions[copy.id] = copy;
        added++;
      }
    }
    for (const [id, incoming] of Object.entries(report.value.trash ?? {})) {
      if (skip.has(id)) continue;
      if (trash[id]) incoming.id = newId();
      trash[id] = incoming;
    }
    for (const [sid, list] of Object.entries(report.value.versions ?? {})) {
      if (skip.has(sid)) continue;
      versions[sid] = [...(list ?? []), ...(versions[sid] ?? [])].slice(0, 20);
    }

    await chrome.storage.local.set({ sessions, trash, versions });
    this._sessions = sessions;
    this._trash = trash;
    this._versions = versions;
    this._notify('sessions');
    this._notify('trash');
    this._notify('versions');
    return {
      imported: added + updated,
      added,
      updated,
      skipped,
      errors: report.errors,
      mode: 'merge',
    };
  }

  // ─── Respaldos automáticos (Fase 8.3) ────────────────────────────────────────

  /**
   * Lee los anillos de backups (read-through).
   * @returns {Promise<{ daily: import('./backups.js').BackupEntry[], event: import('./backups.js').BackupEntry[] }>}
   */
  async getBackups() {
    if (this._backups) return this._backups;
    const raw = await this._getFresh('backups');
    this._backups = {
      daily: Array.isArray(/** @type {any} */ (raw)?.daily) ? raw.daily : [],
      event: Array.isArray(/** @type {any} */ (raw)?.event) ? raw.event : [],
    };
    return this._backups;
  }

  /**
   * Crea un backup con la etiqueta dada. Sin datos → no-op (no llena el anillo).
   * Writable op (SW/alarmas); el popup pasa por REPO_OP.
   * @param {import('./backups.js').BackupLabel} label
   * @returns {Promise<import('./backups.js').BackupEntry|null>} resumen creado
   */
  createBackup(label) {
    this._assertWritable('createBackup');
    return this._enqueue(() => this._snapshotNow(label));
  }

  /**
   * Snapshot del estado ACTUAL → anillo correspondiente. Implementación común
   * de createBackup y del pre-import/pre-restore. Debe llamarse DENTRO de la
   * cola (o desde un contexto ya serializado) — nunca enquee aquí dentro.
   * @private
   * @param {import('./backups.js').BackupLabel} label
   */
  async _snapshotNow(label) {
    const state = {
      sessions: await this._getFresh('sessions'),
      trash: await this._getFresh('trash'),
      versions: await this._getFresh('versions'),
      settings: await this._getFresh('settings'),
    };
    if ((label === 'daily' || label === 'manual') && !hasVaultData(state)) return null;

    const rings = (await this.getBackups()) ?? EMPTY_RINGS;
    const entry = buildBackupEntry(label, Date.now(), state);
    const next = pushBackup(rings, entry);
    await chrome.storage.local.set({ backups: next });
    this._backups = next;
    this._notify('backups');
    return entry;
  }

  /**
   * Restaura un punto en el tiempo. El estado previo se respalda como
   * 'pre-restore' (undo natural: restaurar ese backup revierte).
   * @param {number} ts epoch ms del backup
   * @returns {Promise<{ restored: boolean }>}
   */
  restoreBackup(ts) {
    this._assertWritable('restoreBackup');
    return this._enqueue(async () => {
      const rings = await this.getBackups();
      const entry = findBackupInRings(rings, ts);
      if (!entry) throw new Error('Backup not found');

      // Undo natural: el estado actual queda como punto de restauración.
      await this._snapshotNow('pre-restore');

      const write = { ...entry.data, meta: { schemaVersion: SCHEMA_VERSION } };
      await chrome.storage.local.remove(['sessions', 'trash', 'versions', 'settings']);
      await chrome.storage.local.set(write);
      this.invalidate();
      this._notify('sessions');
      this._notify('trash');
      this._notify('settings');
      return { restored: true };
    });
  }

  /**
   * Borra una entrada de backup por ts.
   * @param {number} ts
   */
  deleteBackup(ts) {
    this._assertWritable('deleteBackup');
    return this._enqueue(async () => {
      const rings = await this.getBackups();
      const filter = (/** @type {import('./backups.js').BackupEntry[]} */ list) =>
        list.filter((e) => e.ts !== ts);
      const next = { daily: filter(rings.daily), event: filter(rings.event) };
      await chrome.storage.local.set({ backups: next });
      this._backups = next;
      this._notify('backups');
    });
  }

  // ─── Rutinas programadas (Fase 9.4) ──────────────────────────────────────────

  /** @returns {Promise<import('../shared/types.js').Routine[]>} */
  async getRoutines() {
    if (this._routines) return this._routines;
    const raw = await this._getFresh('routines');
    this._routines = normalizeRoutines(raw);
    return this._routines;
  }

  /**
   * Crea o actualiza una rutina. Valida time HH:MM.
   * @param {Partial<import('../shared/types.js').Routine> & { sessionId: string, time: string }} routine
   * @returns {Promise<import('../shared/types.js').Routine>}
   */
  saveRoutine(routine) {
    this._assertWritable('saveRoutine');
    return this._enqueue(async () => {
      const routines = normalizeRoutines(await this._getFresh('routines'));
      const id = routine.id && typeof routine.id === 'string' ? routine.id : newId();
      const entry = {
        id,
        sessionId: String(routine.sessionId ?? ''),
        time: String(routine.time ?? ''),
        enabled: routine.enabled !== false,
        created: typeof routine.created === 'number' ? routine.created : Date.now(),
      };
      if (!entry.sessionId || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(entry.time)) {
        throw new Error('Invalid routine: sessionId and time HH:MM required');
      }
      const idx = routines.findIndex((r) => r.id === id);
      if (idx !== -1) routines[idx] = entry;
      else routines.push(entry);
      if (routines.length > 50) routines.splice(0, routines.length - 50);
      await chrome.storage.local.set({ routines });
      this._routines = routines;
      this._notify('routines');
      return entry;
    });
  }

  /** @param {string} id */
  deleteRoutine(id) {
    this._assertWritable('deleteRoutine');
    return this._enqueue(async () => {
      const routines = normalizeRoutines(await this._getFresh('routines'));
      const next = routines.filter((r) => r.id !== id);
      await chrome.storage.local.set({ routines: next });
      this._routines = next;
      this._notify('routines');
    });
  }

  /** @param {string} id @returns {Promise<boolean>} nuevo estado enabled */
  toggleRoutine(id) {
    this._assertWritable('toggleRoutine');
    return this._enqueue(async () => {
      const routines = normalizeRoutines(await this._getFresh('routines'));
      const r = routines.find((x) => x.id === id);
      if (!r) throw new Error('Routine not found');
      r.enabled = !r.enabled;
      await chrome.storage.local.set({ routines });
      this._routines = routines;
      this._notify('routines');
      return r.enabled;
    });
  }

  // ─── Reglas de auto-tag (Fase 9.5) ───────────────────────────────────────────

  /** @returns {Promise<import('../shared/types.js').AutoTagRule[]>} */
  async getAutoTagRules() {
    if (this._autoTagRules) return this._autoTagRules;
    const raw = await this._getFresh('autoTagRules');
    this._autoTagRules = normalizeAutoTagRules(raw);
    return this._autoTagRules;
  }

  /**
   * @param {{ id?: string, pattern: string, tag: string }} rule
   * @returns {Promise<import('../shared/types.js').AutoTagRule>}
   */
  saveAutoTagRule(rule) {
    this._assertWritable('saveAutoTagRule');
    return this._enqueue(async () => {
      const rules = normalizeAutoTagRules(await this._getFresh('autoTagRules'));
      const id = rule.id && typeof rule.id === 'string' ? rule.id : newId();
      const pattern = String(rule.pattern ?? '')
        .trim()
        .toLowerCase()
        .slice(0, 120);
      const tag = String(rule.tag ?? '')
        .trim()
        .slice(0, 40);
      if (!pattern || !tag) throw new Error('pattern and tag required');
      const existing = rules.find((r) => r.id === id);
      if (existing) {
        existing.pattern = pattern;
        existing.tag = tag;
      } else {
        if (rules.length >= 50) throw new Error('Max 50 rules');
        rules.push({ id, pattern, tag });
      }
      await chrome.storage.local.set({ autoTagRules: rules });
      this._autoTagRules = rules;
      this._notify('autoTagRules');
      return { id, pattern, tag };
    });
  }

  /** @param {string} id */
  deleteAutoTagRule(id) {
    this._assertWritable('deleteAutoTagRule');
    return this._enqueue(async () => {
      const rules = normalizeAutoTagRules(await this._getFresh('autoTagRules'));
      const next = rules.filter((r) => r.id !== id);
      await chrome.storage.local.set({ autoTagRules: next });
      this._autoTagRules = next;
      this._notify('autoTagRules');
    });
  }

  /** @param {import('../shared/types.js').AutoTagRule[]} rules */
  setAutoTagRules(rules) {
    this._assertWritable('setAutoTagRules');
    return this._enqueue(async () => {
      const normalized = normalizeAutoTagRules(rules);
      await chrome.storage.local.set({ autoTagRules: normalized });
      this._autoTagRules = normalized;
      this._notify('autoTagRules');
      return normalized;
    });
  }

  // ─── Store LRU de favicons por dominio (Fase 10.2) ──────────────────────────

  /** @returns {Promise<import('./favicons.js').FaviconStore>} */
  async getFavicons() {
    if (this._favicons) return this._favicons;
    this._favicons = normalizeFaviconStore(await this._getFresh('favicons'));
    return this._favicons;
  }

  /**
   * Registra favicons resueltos por una captura (UNO por dominio). Escritura
   * única con poda LRU; solo el SW la invoca (no está en REMOTE_OPS a propósito:
   * el popup jamás escribe favicons).
   * @param {{ domain?: string, url?: string, dataUrl?: string }[]} pairs
   * @returns {Promise<import('./favicons.js').FaviconStore>}
   */
  rememberFavicons(pairs) {
    this._assertWritable('rememberFavicons');
    return this._enqueue(async () => {
      const current = await this.getFavicons();
      const next = rememberFaviconsIn(current, Array.isArray(pairs) ? pairs : [], Date.now());
      if (next === current) return current;
      await chrome.storage.local.set({ favicons: next });
      this._favicons = next;
      this._notify('favicons');
      return next;
    });
  }
}

/**
 * Instancia singleton lista para el service worker (único escritor).
 * El popup NO debe usar esto; usar popup/repoClient.js.
 */
export const repository = /* @__PURE__ */ new Repository({ writable: true });
