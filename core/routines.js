// core/routines.js — Rutinas programadas (Fase 9.4).
// Modelo puro: sin chrome.*, sin I/O. El SW consume nextRunAt() para armar alarms.

/** @typedef {{ id: string, sessionId: string, time: string, enabled: boolean, created: number }} Routine */

/**
 * Valida "HH:MM" 24h. @param {unknown} raw @returns {boolean}
 */
export function isValidTime(raw) {
  if (typeof raw !== 'string') return false;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(raw);
  return !!m;
}

/**
 * Normaliza una rutina cruda. Devuelve null si sessionId/time inválidos.
 * @param {unknown} raw
 * @returns {Routine|null}
 */
export function normalizeRoutine(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const r = /** @type {Record<string, unknown>} */ (raw);
  if (typeof r.sessionId !== 'string' || !r.sessionId) return null;
  if (!isValidTime(r.time)) return null;
  const id = typeof r.id === 'string' && r.id ? r.id : '';
  if (!id) return null;
  return {
    id,
    sessionId: r.sessionId,
    time: /** @type {string} */ (r.time),
    enabled: r.enabled !== false,
    created: typeof r.created === 'number' && Number.isFinite(r.created) ? r.created : Date.now(),
  };
}

/**
 * Próxima ejecución de "HH:MM" desde `now`. Siempre en el futuro (mañana si ya pasó hoy).
 * @param {string} time "HH:MM"
 * @param {number} [now=Date.now()]
 * @returns {number} epoch ms
 */
export function nextRunAt(time, now = Date.now()) {
  const [h, m] = time.split(':').map(Number);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/**
 * Ordena rutinas por próxima ejecución asc.
 * @param {Routine[]} routines
 * @param {number} [now]
 * @returns {Routine[]}
 */
export function sortedRoutines(routines, now = Date.now()) {
  return [...routines].sort((a, b) => nextRunAt(a.time, now) - nextRunAt(b.time, now));
}

/**
 * Genera nombre de alarma estable para una rutina.
 * @param {string} routineId
 * @returns {string}
 */
export function alarmNameFor(routineId) {
  return `tabvault-routine-${routineId}`;
}

/**
 * Detecta si una alarma pertenece a rutinas.
 * @param {string} name
 * @returns {boolean}
 */
export function isRoutineAlarm(name) {
  return name.startsWith('tabvault-routine-');
}

/**
 * Extrae routineId de un nombre de alarma.
 * @param {string} name
 * @returns {string|null}
 */
export function routineIdFromAlarm(name) {
  if (!isRoutineAlarm(name)) return null;
  return name.slice('tabvault-routine-'.length) || null;
}
