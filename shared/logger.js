// shared/logger.js — Logger local con niveles y ring-buffer en storage.session
// (Fase 10.5). SIN telemetría de red: los logs viven y mueren en el navegador.
//
// Niveles: debug < info < warn < error. El nivel activo se resuelve así:
//   1. setLevel() explícito (tests / arranque del SW)
//   2. env LOG_LEVEL donde exista (node/tests; los contextos de extensión no
//      tienen process: queda el default)
//   3. default 'warn'
//
// El ring-buffer (cap 200) es best-effort: si storage.session no está
// disponible (tests sin mock, contexto restringido) se degrada a memoria.

/** @typedef {'debug'|'info'|'warn'|'error'} LogLevel */

const LEVELS = /** @type {Record<LogLevel, number>} */ ({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
});

const KEY = 'tabvault-log';
const MAX_ENTRIES = 200;

let activeLevel = resolveInitialLevel();

/** @returns {number} */
function resolveInitialLevel() {
  // Env solo existe en node/tests; en el navegador queda el default.
  try {
    const envLevel = /** @type {any} */ (globalThis).process?.env?.LOG_LEVEL;
    if (typeof envLevel === 'string' && envLevel.toLowerCase() in LEVELS) {
      return LEVELS[/** @type {LogLevel} */ (envLevel.toLowerCase())];
    }
  } catch {
    /* sin process: default */
  }
  return LEVELS.warn;
}

/** @param {LogLevel} level */
export function setLevel(level) {
  if (level in LEVELS) activeLevel = LEVELS[level];
}

/**
 * SOLO tests: vacía el ring en memoria y fuerza re-hidratación.
 * El ring es estado de módulo; sin esto, los tests se contaminan entre sí.
 */
export function __resetForTests() {
  memoryRing.length = 0;
  hydrated = false;
}

/** @returns {LogLevel} */
export function getLevel() {
  return /** @type {LogLevel} */ (
    Object.keys(LEVELS).find((k) => LEVELS[/** @type {LogLevel} */ (k)] === activeLevel) ?? 'warn'
  );
}

/** Ring en memoria: fuente SÍNCRONA del logger (log() nunca espera I/O). */
const memoryRing = /** @type {Array<Record<string, unknown>>} */ ([]);
let hydrated = false;

/**
 * @param {LogLevel} level
 * @param {string} area
 * @param {string} message
 * @param {unknown} [extra]
 */
export function log(level, area, message, extra) {
  if (LEVELS[level] < activeLevel) return;
  const entry = {
    at: Date.now(),
    level,
    area: String(area).slice(0, 40),
    message: String(message).slice(0, 500),
    ...(extra !== undefined ? { extra: safeExtra(extra) } : {}),
  };
  // Consola siempre (visible en DevTools del contexto).
  const line = `[TabVault:${area}] ${message}`;
  if (level === 'error') console.error(line, extra ?? '');
  else if (level === 'warn') console.warn(line, extra ?? '');
  else console.log(line, extra ?? '');

  pushMemory(entry);
  void mirrorToStorage();
}

/** @param {Record<string, unknown>} entry */
function pushMemory(entry) {
  memoryRing.push(entry);
  while (memoryRing.length > MAX_ENTRIES) memoryRing.shift();
}

/**
 * Espejo best-effort del ring en storage.session (sobrevive al sleep del SW
 * dentro de la sesión del navegador). Hidratación única al primer uso.
 */
async function mirrorToStorage() {
  try {
    const api = /** @type {any} */ (globalThis).chrome?.storage?.session;
    if (!api?.get) return;
    if (!hydrated) {
      hydrated = true;
      const got = await api.get(KEY);
      const stored = Array.isArray(got?.[KEY]) ? got[KEY] : [];
      if (memoryRing.length === 0 && stored.length > 0) {
        memoryRing.push(...stored.slice(-MAX_ENTRIES));
        return;
      }
    }
    await api.set({ [KEY]: [...memoryRing] });
  } catch {
    /* el log jamás rompe la app */
  }
}

/** Extra serializable y acotado (nunca rompe el log). @param {unknown} extra */
function safeExtra(extra) {
  try {
    const json = JSON.stringify(extra);
    return json.length > 1000 ? json.slice(0, 1000) : extra;
  } catch {
    return String(extra);
  }
}

/**
 * Copia de los últimos logs (ring en memoria, hidratado desde storage.session
 * si este contexto acabó de despertar).
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function getRecentLogs() {
  if (!hydrated) {
    try {
      const api = /** @type {any} */ (globalThis).chrome?.storage?.session;
      if (api?.get) {
        hydrated = true;
        const got = await api.get(KEY);
        const stored = Array.isArray(got?.[KEY]) ? got[KEY] : [];
        if (memoryRing.length === 0 && stored.length > 0) {
          memoryRing.push(...stored.slice(-MAX_ENTRIES));
        }
      }
    } catch {
      hydrated = true;
    }
  }
  return structuredClone(memoryRing);
}

/**
 * Logger con área prefijada.
 * @param {string} area
 */
export function createLogger(area) {
  return {
    /** @param {string} m @param {unknown} [e] */
    debug: (m, e) => log('debug', area, m, e),
    /** @param {string} m @param {unknown} [e] */
    info: (m, e) => log('info', area, m, e),
    /** @param {string} m @param {unknown} [e] */
    warn: (m, e) => log('warn', area, m, e),
    /** @param {string} m @param {unknown} [e] */
    error: (m, e) => log('error', area, m, e),
  };
}

/**
 * Informe de soporte para "Copiar diagnóstico" (Settings, Fase 10.5).
 * Todo local: versión, UA, settings NO sensibles, logs y errores recientes.
 * @param {{ errors?: Array<Record<string, unknown>> }} [opts]
 * @returns {Promise<string>}
 */
export async function buildSupportReport(opts = {}) {
  const [logs, manifest] = await Promise.all([
    getRecentLogs(),
    Promise.resolve(/** @type {any} */ (globalThis).chrome?.runtime?.getManifest?.() ?? null),
  ]);
  const lines = [
    '=== TabVault diagnostics (local only) ===',
    `at: ${new Date().toISOString()}`,
    `version: ${manifest?.version ?? '?'}`,
    `logLevel: ${getLevel()}`,
    `userAgent: ${typeof navigator !== 'undefined' ? navigator.userAgent : '?'}`,
    `recent errors: ${(opts.errors ?? []).length}`,
    '',
    '--- recent logs (oldest first) ---',
    ...logs.map(
      (l) => `${new Date(/** @type {any} */ (l.at)).toISOString()} ${l.level} [${l.area}] ${l.message}`
    ),
    '',
    '--- unhandled errors (ring 30) ---',
    ...(opts.errors ?? []).map((e) => `${new Date(/** @type {any} */ (e.at)).toISOString()} ${e.message}`),
  ];
  return lines.join('\n');
}
