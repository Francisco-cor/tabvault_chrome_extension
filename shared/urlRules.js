// shared/urlRules.js — Única fuente de verdad sobre qué URLs son capturables (M6).
// Antes popup.js y service-worker.js filtraban con prefijos distintos y a medias;
// ahora TODOS los flujos de captura/restauración usan isValidTabUrl().

/** Prefijos internos del navegador: nunca se guardan ni restauran. */
export const BLOCKED_PREFIXES = Object.freeze([
  'chrome://',
  'chrome-extension://',
  'edge://',
  'about:',
  'devtools://',
  'view-source:',
  'chrome-untrusted://',
]);

const CAPTURABLE_PROTOCOLS = new Set(['http:', 'https:', 'file:']);

/**
 * ¿Puede esta URL de una tab real entrar al vault?
 * Más estricto que el bloqueo por prefijos: solo esquemas capturables.
 * Coincide con safeUrl() de core/schema (http/https/file) para que nada
 * capturado termine descartado al normalizar.
 * @param {unknown} url
 * @returns {boolean}
 */
export function isValidTabUrl(url) {
  if (typeof url !== 'string' || url.length === 0 || url.length > 4000) return false;
  for (const prefix of BLOCKED_PREFIXES) {
    if (url.startsWith(prefix)) return false;
  }
  try {
    return CAPTURABLE_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}
