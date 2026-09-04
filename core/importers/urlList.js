// core/importers/urlList.js — Importador genérico "lista de URLs" (Fase 8.2).
// Una URL por línea; dominios sin esquema se completan con https://.
// Líneas vacías y comentarios (#) se ignoran. Nunca lanza.

import { MAX_IMPORT_TABS } from './draft.js';

/** ¿Parece un hostname? (punto, sin espacios, TLD corto al final). @param {string} s */
function looksLikeDomain(s) {
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(s) && !s.includes(' ');
}

/**
 * @param {string} text
 * @returns {{ drafts: import('./draft.js').SessionDraft[], truncated: boolean }}
 */
export function parseUrlList(text) {
  /** @type {import('./draft.js').DraftTab[]} */
  const tabs = [];
  let truncated = false;

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (tabs.length >= MAX_IMPORT_TABS) {
      truncated = true;
      break;
    }
    const token = line.split(/\s+/)[0];
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) {
      tabs.push({ url: token, title: '' });
    } else if (looksLikeDomain(token)) {
      tabs.push({ url: `https://${token}`, title: '' });
    }
  }

  const drafts = tabs.length ? [{ name: 'Imported URL list', ungroupedTabs: tabs }] : [];
  return { drafts, truncated };
}
