// core/backups.js — Respaldos automáticos (Fase 8.3). Helpers PUROS sobre
// chrome.storage: aquí no hay I/O; Repository los orquesta dentro de su cola.
//
// Diseño:
//  - Dos anillos bajo la clave `backups` de storage.local:
//      daily  cap 7  → alarm diaria del SW
//      event  cap 3  → pre-import / pre-restore / manual
//    Separados para que un import nunca expulse el histórico diario.
//  - Los snapshots NO guardan favicons (como las versiones): ahorro dominante.

/** @typedef {'daily'|'pre-import'|'pre-restore'|'manual'} BackupLabel */

export const BACKUP_CAPS = Object.freeze({ daily: 7, event: 3 });

/** Estado inicial de los anillos. @type {{ daily: never[], event: never[] }} */
export const EMPTY_RINGS = { daily: [], event: [] };

/** @typedef {Object} BackupEntry
 * @property {BackupLabel} label
 * @property {number} ts                    epoch ms (id del entry)
 * @property {number} size                  bytes del JSON del snapshot
 * @property {{ sessions: number, tabs: number, trash: number }} counts
 * @property {{ sessions?: Record<string, any>, trash?: Record<string, any>, versions?: Record<string, any>, settings?: any }} data
 */

/**
 * Categoría de anillo según etiqueta. @param {BackupLabel} label
 * @returns {'daily'|'event'}
 */
export function ringOf(label) {
  return label === 'daily' ? 'daily' : 'event';
}

/**
 * Quita recursivamente TODOS los favicons de sesiones/trash/versions.
 * Puro: clona antes de tocar.
 * @param {any} value
 * @returns {any}
 */
export function stripFavicons(value) {
  if (Array.isArray(value)) return value.map(stripFavicons);
  if (!value || typeof value !== 'object') return value;
  const out = /** @type {Record<string, any>} */ ({});
  for (const [k, v] of Object.entries(value)) {
    out[k] = k === 'favicon' ? '' : stripFavicons(v);
  }
  return out;
}

/**
 * Construye una entrada de backup a partir del estado crudo de storage.
 * Clona, vacía favicons y mide tamaño/contadores. Pura.
 *
 * @param {BackupLabel} label
 * @param {number} ts epoch ms
 * @param {{ sessions?: Record<string, any>, trash?: Record<string, any>, versions?: Record<string, any>, settings?: any }} state
 * @returns {BackupEntry}
 */
export function buildBackupEntry(label, ts, state) {
  const data = /** @type {BackupEntry['data']} */ (
    stripFavicons({
      ...(state.sessions ? { sessions: state.sessions } : {}),
      ...(state.trash ? { trash: state.trash } : {}),
      ...(state.versions ? { versions: state.versions } : {}),
      ...(state.settings ? { settings: state.settings } : {}),
    })
  );
  const sessions = Object.values(data.sessions ?? {});
  const tabs = sessions.reduce((n, s) => n + (s?.metadata?.tabCount ?? 0), 0);
  return {
    label,
    ts,
    size: JSON.stringify(data).length,
    counts: {
      sessions: sessions.length,
      tabs,
      trash: Object.keys(data.trash ?? {}).length,
    },
    data,
  };
}

/**
 * Inserta en el anillo correspondiente respetando su cap. Pura.
 * @param {{ daily: BackupEntry[], event: BackupEntry[] }} rings estado actual
 * @param {BackupEntry} entry
 * @returns {{ daily: BackupEntry[], event: BackupEntry[] }} nuevo estado
 */
export function pushBackup(rings, entry) {
  const key = ringOf(entry.label);
  const next = { daily: rings.daily ?? [], event: rings.event ?? [] };
  next[key] = [entry, ...next[key]].slice(0, BACKUP_CAPS[key]);
  return next;
}

/**
 * Busca una entrada por ts en ambos anillos.
 * @param {{ daily?: BackupEntry[], event?: BackupEntry[] }} rings
 * @param {number} ts
 * @returns {BackupEntry|null}
 */
export function findBackup(rings, ts) {
  for (const list of [rings.daily ?? [], rings.event ?? []]) {
    const hit = list.find((e) => e.ts === ts);
    if (hit) return hit;
  }
  return null;
}

/** ¿Hay algo que respaldar? Evita llenar el anillo diario con snapshots vacíos.
 * @param {{ sessions?: Record<string, any>, trash?: Record<string, any> }} state */
export function hasVaultData(state) {
  return Object.keys(state.sessions ?? {}).length > 0 || Object.keys(state.trash ?? {}).length > 0;
}

const DAY_MS = 86_400_000;

/**
 * ¿Toca recordar exportar? Verdadero si pasaron ≥14 días desde el último export
 * manual Y desde el último dismiss. El llamador además exige tener sesiones.
 * Pura y determinista (reloj inyectado).
 *
 * @param {number} lastManualExport epoch ms (0 = nunca)
 * @param {number} reminderDismissedAt epoch ms (0 = nunca)
 * @param {number} now epoch ms
 * @param {{ days?: number }} [opts]
 */
export function shouldRemindExport(lastManualExport, reminderDismissedAt, now, opts = {}) {
  const days = opts.days ?? 14;
  const threshold = days * DAY_MS;
  return now - lastManualExport >= threshold && now - reminderDismissedAt >= threshold;
}
