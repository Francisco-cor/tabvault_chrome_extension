// core/migrations.js — Versionado de esquema con backup previo e idempotencia.
// meta = { schemaVersion: number } vive en chrome.storage.local.

import { normalizeSession, normalizeSettings } from './schema.js';
import { collectFaviconsFromVault, normalizeFaviconStore, rememberFavicon } from './favicons.js';

export const SCHEMA_VERSION = 4;
const META_KEY = 'meta';

/**
 * Registro de migraciones. Cada entrada: (storage, from) → muta `storage` en memoria.
 * Deben ser IDEMPOTENTES por diseño y nunca lanzar (log + continuar).
 * @type {Record<number, (data: Record<string, any>, log: (m: string) => void) => void>}
 */
const MIGRATIONS = {
  /**
   * legacy/2 → 3: normaliza entidades, garantiza arrays y settings completos.
   * No hay cambio de forma rompedor; el objetivo es sanear datos históricos
   * y estampar la marca de versión.
   */
  3: (data, log) => {
    if (data.sessions && typeof data.sessions === 'object') {
      let repaired = 0;
      for (const [id, raw] of Object.entries(data.sessions)) {
        const norm = normalizeSession(raw);
        if (!norm) {
          delete data.sessions[id];
          log(`sesión "${id}" irrecuperable → eliminada`);
          continue;
        }
        data.sessions[id] = { ...norm, id }; // conserva el id original si era válido
        repaired++;
      }
      log(`sesiones normalizadas: ${repaired}`);
    }
    if (data.trash && typeof data.trash === 'object') {
      for (const [id, raw] of Object.entries(data.trash)) {
        const norm = normalizeSession(raw);
        const deletedAt = /** @type {any} */ (raw)?.deletedAt ?? Date.now();
        if (!norm) {
          delete data.trash[id];
          log(`papelera "${id}" irrecuperable → eliminada`);
          continue;
        }
        data.trash[id] = { ...norm, id, deletedAt };
      }
    }
    if (data.settings !== undefined) {
      data.settings = normalizeSettings(data.settings);
    }
  },

  /**
   * 3 → 4: favicons por DOMINIO (Fase 10.2). Deduplica las data-URLs repetidas
   * en el store LRU `favicons` y vacía el campo favicon de cada tab. Idempotente:
   * una segunda pasada no encuentra data-URLs y el store queda intacto.
   */
  4: (data, log) => {
    // Merge sobre un store pre-existente (defensa anti-wipe en re-ejecuciones).
    let merged = normalizeFaviconStore(data.favicons);
    const { store, deduped, stripped } = collectFaviconsFromVault(data, Date.now());
    for (const [domain, entry] of Object.entries(store.entries)) {
      merged = rememberFavicon(merged, domain, entry.data, Date.now());
    }
    data.favicons = merged;
    log(
      `favicons: ${Object.keys(merged.entries).length} dominios · ` +
        `${deduped} duplicados fusionados · ${stripped} tabs limpiadas`
    );
  },
};

/**
 * Ejecuta migraciones pendientes. Idempotente: si ya está en SCHEMA_VERSION, no-op.
 * Crea backup `backup_preMigration_v<from>_v<to>_<ts>` cuando hay datos que tocar.
 *
 * @param {{ get: (k: any) => Promise<any>, set: (o: object) => Promise<void> }} storageAdapter
 * @param {(m: string) => void} [log]
 * @returns {Promise<{ migrated: boolean, from: number, to: number, backupKey?: string }>}
 */
export async function migrateIfNeeded(storageAdapter, log = () => {}) {
  const current = await storageAdapter.get([
    META_KEY,
    'sessions',
    'trash',
    'versions',
    'settings',
    'favicons', // v4 necesita el store pre-existente para el merge idempotente
  ]);
  const from = Number(/** @type {any} */ (current[META_KEY])?.schemaVersion ?? 0);

  if (from >= SCHEMA_VERSION) {
    return { migrated: false, from, to: from };
  }

  // ¿Hay algo que migrar de verdad?
  const hasData =
    (current.sessions && Object.keys(current.sessions).length > 0) ||
    (current.trash && Object.keys(current.trash).length > 0) ||
    (current.versions && Object.keys(current.versions).length > 0);

  const to = SCHEMA_VERSION;

  // Backup puntual antes del primer toque (solo si hay datos)
  let backupKey;
  if (hasData) {
    backupKey = `backup_preMigration_v${from}_v${to}_${Date.now()}`;
    await storageAdapter.set({
      [backupKey]: {
        sessions: current.sessions ?? {},
        trash: current.trash ?? {},
        versions: current.versions ?? {},
        createdAt: Date.now(),
      },
    });
    log(`backup creado: ${backupKey}`);
  }

  /** @type {Record<string, any>} */
  const working = {
    sessions: current.sessions ?? {},
    trash: current.trash ?? {},
    versions: current.versions ?? {},
    ...(current.favicons !== undefined ? { favicons: current.favicons } : {}),
  };

  for (let v = Math.max(from, 2); v <= to; v++) {
    const fn = MIGRATIONS[v];
    if (!fn) continue;
    try {
      fn(working, (m) => log(`v${v}: ${m}`));
    } catch (e) {
      log(`v${v} error (se continúa): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  await storageAdapter.set({
    ...working,
    ...(current.settings !== undefined ? { settings: normalizeSettings(current.settings) } : {}),
    [META_KEY]: { schemaVersion: to },
  });

  return { migrated: true, from, to, backupKey };
}
