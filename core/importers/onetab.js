// core/importers/onetab.js — Parser del export de texto de OneTab (Fase 8.2).
// Formato real: líneas `URL | título`, bloques separados por líneas en blanco.
// Tolerante: sin URLs reconocibles → drafts vacíos (la UI avisa), nunca throw.

import { MAX_IMPORT_TABS } from './draft.js';

const TAB_LINE_RE = /^([a-z][a-z0-9+.-]*:\/\/\S+)(?:\s+\|\s*(.*))?$/i;

/**
 * @param {string} text
 * @returns {{ drafts: import('./draft.js').SessionDraft[], truncated: boolean }}
 */
export function parseOneTab(text) {
  /** @type {import('./draft.js').SessionDraft[]} */
  const drafts = [];
  let count = 0;
  let truncated = false;

  const blocks = String(text).split(/\r?\n\s*\r?\n/);
  for (let i = 0; i < blocks.length; i++) {
    /** @type {import('./draft.js').DraftTab[]} */
    const tabs = [];
    let title = '';

    for (const rawLine of blocks[i].split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.match(TAB_LINE_RE);
      if (m) {
        if (count >= MAX_IMPORT_TABS) {
          truncated = true;
          break;
        }
        count++;
        tabs.push({ url: m[1], title: (m[2] ?? '').trim() });
      } else if (!title) {
        title = line; // primera línea no-URL: título del bloque si el export lo trae
      }
    }

    if (tabs.length > 0) {
      drafts.push({ name: title || `OneTab ${drafts.length + 1}`, ungroupedTabs: tabs });
    }
    if (truncated) break;
  }
  return { drafts, truncated };
}
