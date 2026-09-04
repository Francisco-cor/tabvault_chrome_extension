// ui/services/diagnostics.js — Log local de errores en storage.session (4.6).
// Ring-buffer acotado; sin red, sin telemetría. Sirve para diagnóstico manual.

const KEY = 'tabvault-diagnostics';
const MAX_ENTRIES = 30;

/** @param {unknown} err */
export async function logDiagnostic(err) {
  try {
    const entry = {
      at: Date.now(),
      message: err instanceof Error ? err.message : String(err ?? 'unknown'),
      stack: err instanceof Error ? (err.stack ?? '').slice(0, 2000) : '',
    };
    const got = await chrome.storage.session.get(KEY);
    const list = Array.isArray(got[KEY]) ? /** @type {any[]} */ (got[KEY]) : [];
    list.push(entry);
    while (list.length > MAX_ENTRIES) list.shift();
    await chrome.storage.session.set({ [KEY]: list });
  } catch {
    /* el diagnóstico nunca debe romper la app */
  }
}

/** @returns {Promise<any[]>} copia del buffer actual */
export async function getDiagnostics() {
  try {
    const got = await chrome.storage.session.get(KEY);
    return Array.isArray(got[KEY]) ? structuredClone(got[KEY]) : [];
  } catch {
    return [];
  }
}
