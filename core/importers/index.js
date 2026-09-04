// core/importers/index.js — Detección y despacho de formatos de import (Fase 8.2).
// El flujo SIEMPRE termina en un payload {_tabvault:true,…} que Repository
// re-valida con core/schema.js: la conversión no es una vía de escape de C7/C8.
//
// Los archivos .tabvault.enc se detectan por BYTES (magic TBVE) antes de llegar
// aquí; el llamador descifra con core/crypto.js y reentra como 'tabvault'.

import { draftsToPayload } from './draft.js';
import { parseNetscapeHtml, netscapeToDrafts } from './netscape.js';
import { parseOneTab } from './onetab.js';
import { parseUrlList } from './urlList.js';
import { parseSessionBuddy } from './sessionBuddy.js';

/** @typedef {'netscape'|'onetab'|'url-list'|'session-buddy'} ForeignFormat */

const NETSCAPE_HINT_RE = /NETSCAPE-Bookmark|<DT>\s*<A\s+HREF=/i;
const URL_LINE_RE = /^[a-z][a-z0-9+.-]*:\/\/\S+/i;

/**
 * Detecta el formato a partir del nombre de archivo + contenido.
 * @param {string} filename @param {string} text
 * @returns {ForeignFormat|null} null = desconocido
 */
export function detectImportFormat(filename, text) {
  const head = String(text).slice(0, 500);
  if (/\.html?$/i.test(filename) || NETSCAPE_HINT_RE.test(head)) {
    return NETSCAPE_HINT_RE.test(String(text)) ? 'netscape' : null;
  }

  const trimmed = String(text).trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    // JSON: Session Buddy o nada (los .json de TabVault van por su propio camino).
    const probe = parseSessionBuddy(text);
    return probe ? 'session-buddy' : null;
  }

  let urlLines = 0;
  let pipedLines = 0;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (URL_LINE_RE.test(line) || /^[a-z0-9.-]+\.[a-z]{2,}(\/|\s|$)/i.test(line)) {
      urlLines++;
      if (/\s\|\s/.test(line)) pipedLines++;
      if (urlLines >= 3) break;
    }
  }
  if (urlLines === 0) return null;
  return pipedLines > 0 ? 'onetab' : 'url-list';
}

/**
 * Convierte texto extranjero en payload TabVault validado.
 * @param {ForeignFormat} format
 * @param {string} text
 * @returns {{ payload: Record<string, unknown>, warnings: string[], format: ForeignFormat } | null}
 */
export function convertToPayload(format, text) {
  /** @type {{ drafts: import('./draft.js').SessionDraft[], truncated: boolean } | null} */
  let parsed = null;
  switch (format) {
    case 'netscape': {
      const tree = parseNetscapeHtml(text);
      parsed = netscapeToDrafts(tree.root);
      if (tree.truncated) parsed.truncated = true;
      break;
    }
    case 'onetab':
      parsed = parseOneTab(text);
      break;
    case 'url-list':
      parsed = parseUrlList(text);
      break;
    case 'session-buddy':
      parsed = parseSessionBuddy(text);
      break;
    default:
      return null;
  }
  if (!parsed || parsed.drafts.length === 0) return null;

  const { payload, warnings } = draftsToPayload(parsed.drafts);
  if (parsed.truncated) warnings.push('file truncated at the safety cap (50k tabs)');
  return { payload, warnings, format };
}
