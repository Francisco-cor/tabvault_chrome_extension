// core/importers/sessionBuddy.js — Importador del JSON de Session Buddy (Fase 8.2).
// Formatos aceptados (tolerantes entre versiones de la herramienta):
//   { sessions: [ { name|title?, created?, tabs: [ { url, title } ] } ] }
//   [ { ...igual que arriba... } ]
// Devuelve null cuando el texto NO se parece a Session Buddy (para que el
// detector pruebe otro formato). Nunca lanza.

import { MAX_IMPORT_TABS, looseMs } from './draft.js';

/**
 * @param {string} text
 * @returns {{ drafts: import('./draft.js').SessionDraft[], truncated: boolean } | null}
 */
export function parseSessionBuddy(text) {
  /** @type {any} */
  let data;
  try {
    data = JSON.parse(String(text));
  } catch {
    return null;
  }

  const list = Array.isArray(data) ? data : Array.isArray(data?.sessions) ? data.sessions : null;
  if (!list || list.length === 0) return null;

  /** @type {import('./draft.js').SessionDraft[]} */
  const drafts = [];
  let count = 0;
  let truncated = false;

  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    if (!entry || typeof entry !== 'object') continue;
    const tabsRaw = Array.isArray(entry.tabs) ? entry.tabs : null;
    if (!tabsRaw || tabsRaw.length === 0) continue;

    const created = looseMs(entry.created ?? entry.dateCreated);
    /** @type {import('./draft.js').DraftTab[]} */
    const tabs = [];
    for (const t of tabsRaw) {
      if (!t || typeof t !== 'object') continue;
      if (count >= MAX_IMPORT_TABS) {
        truncated = true;
        break;
      }
      const url = typeof t.url === 'string' ? t.url.trim() : '';
      if (!url) continue;
      count++;
      tabs.push({ url, title: typeof t.title === 'string' ? t.title : '' });
    }
    if (tabs.length === 0 && !created) continue;

    drafts.push({
      name:
        typeof entry.name === 'string' && entry.name.trim()
          ? entry.name.trim()
          : typeof entry.title === 'string' && entry.title.trim()
            ? entry.title.trim()
            : `Session Buddy ${i + 1}`,
      ...(created ? { created } : {}),
      ungroupedTabs: tabs,
    });
    if (truncated) break;
  }

  return drafts.length > 0 ? { drafts, truncated } : null;
}
