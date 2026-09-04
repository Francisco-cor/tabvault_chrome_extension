// shared/utils.js — Formatting, colors, and helpers
/** @typedef {import('./types.js').Session} Session */
/** @typedef {import('./types.js').SessionMap} SessionMap */
/** @typedef {import('./types.js').TabItem} TabItem */

// El motor de búsqueda vive desde Fase 7 en core/searchIndex.js
// (índice invertido + ranking); searchSessions fue eliminado junto con su
// warning heredado de complejidad.

// ─── Formatting ──────────────────────────────────────────────────────────────

/**
 * @param {number} ts epoch ms
 * @param {number} [now] reloj inyectable (tick de 60s de la UI); default Date.now()
 * @returns {string}
 */
export function formatRelativeTime(ts, now = Date.now()) {
  const diff = now - ts;
  const m = Math.floor(diff / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 30) return new Date(ts).toLocaleDateString();
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  if (m > 0) return `${m}m ago`;
  return 'just now';
}

/** @param {number} ts epoch ms */
export function formatDate(ts) {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * @param {string} url
 * @param {number} [maxLen=48]
 */
export function truncateUrl(url, maxLen = 48) {
  try {
    const u = new URL(url);
    const short = u.hostname + (u.pathname !== '/' ? u.pathname : '');
    return short.length > maxLen ? short.slice(0, maxLen) + '…' : short;
  } catch {
    return url.slice(0, maxLen);
  }
}

// ─── Chrome group color map ──────────────────────────────────────────────────

export const GROUP_COLORS = {
  grey: '#5f6368',
  blue: '#1a73e8',
  red: '#d93025',
  yellow: '#f29900',
  green: '#188038',
  pink: '#d01884',
  purple: '#a142f4',
  cyan: '#007b83',
  orange: '#fa903e',
};

export const VALID_COLORS = Object.keys(GROUP_COLORS);

/** @param {string} color clave de GROUP_COLORS */
export function groupColorHex(color) {
  return /** @type {{ [k: string]: string }} */ (GROUP_COLORS)[color] ?? GROUP_COLORS.purple;
}

// ─── Download helpers ────────────────────────────────────────────────────────

/** @param {string} content @param {string} filename */
export function downloadText(content, filename) {
  downloadBytes(new TextEncoder().encode(content), filename, 'text/plain;charset=utf-8');
}

/**
 * Descarga bytes binarios (respaldos .tabvault.enc, Fase 8.2).
 * @param {Uint8Array|ArrayBuffer} content
 * @param {string} filename
 * @param {string} [mime]
 */
export function downloadBytes(content, filename, mime = 'application/octet-stream') {
  const blob = new Blob([/** @type {any} */ (content)], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** @param {File} file @returns {Promise<string>} */
export function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(/** @type {string} */ (e.target?.result));
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

/**
 * Lee un archivo como ArrayBuffer (detección .enc por magic bytes).
 * @param {File} file @returns {Promise<ArrayBuffer>}
 */
export function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(/** @type {ArrayBuffer} */ (e.target?.result));
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

/** @param {string} name */
export function sanitizeName(name) {
  return name.trim().replace(/[/\\?%*:|"<>]/g, '-') || 'tabvault-export';
}
