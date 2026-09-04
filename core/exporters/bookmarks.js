// core/exporters/bookmarks.js — Export Netscape Bookmark HTML (Fase 8.2).
// Formato compatible con el gestor de marcadores de Chrome/Firefox:
//   carpeta raíz "TabVault" → carpeta por sesión → subcarpeta por grupo.
// Las tags viajan en el atributo TAGS (Firefox las lee; Chrome las ignora).

import { safeUrl } from '../schema.js';

/** @typedef {import('../../shared/types.js').Session} Session */

/** @param {string} s texto/atributo HTML escapado */
function esc(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** epoch ms → segundos Netscape. @param {number} ms */
const toSec = (ms) => Math.max(0, Math.floor(ms / 1000));

/**
 * @param {string} url
 * @param {string} title
 * @param {number} savedAt
 * @param {string[]|undefined} tags
 */
function bookmarkLine(url, title, savedAt, tags) {
  const safe = safeUrl(url);
  if (!safe) return '';
  const attrs = [`HREF="${esc(safe)}"`, `ADD_DATE="${toSec(savedAt)}"`];
  if (tags?.length) attrs.push(`TAGS="${esc(tags.join(','))}"`);
  return `        <DT><A ${attrs.join(' ')}>${esc(title || safe)}</A>\n`;
}

/**
 * @param {string} name
 * @param {number} ts
 * @param {string} body líneas ya indentadas
 */
function folderBlock(name, ts, body) {
  return [
    `      <DT><H3 ADD_DATE="${toSec(ts)}" LAST_MODIFIED="${toSec(ts)}">${esc(name)}</H3>\n`,
    `      <DL><p>\n`,
    body,
    `      </DL><p>\n`,
  ].join('');
}

/**
 * Exporta sesiones a Netscape Bookmark HTML. Pura.
 * @param {Session[]} sessions
 * @param {{ title?: string }} [opts]
 * @returns {string}
 */
export function sessionsToBookmarksHtml(sessions, opts = {}) {
  const rootTitle = opts.title ?? 'TabVault Bookmarks';
  /** @type {string[]} */
  const out = [];
  out.push('<!DOCTYPE NETSCAPE-Bookmark-file-1>\n');
  out.push('<!-- This is an automatically generated file by TabVault.\n');
  out.push('     It will be read and overwritten. DO NOT EDIT. -->\n');
  out.push('<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n');
  out.push(`<TITLE>${esc(rootTitle)}</TITLE>\n`);
  out.push(`<H1>${esc(rootTitle)}</H1>\n`);
  out.push('<DL><p>\n');

  for (const session of sessions ?? []) {
    /** @type {string[]} */
    const inner = [];
    for (const group of session.groups ?? []) {
      if (!group.tabs?.length) continue;
      const tabs = group.tabs.map((t) => bookmarkLine(t.url, t.title, t.savedAt, t.tags)).join('');
      if (!tabs) continue;
      inner.push(folderBlock(group.name || 'Untitled Group', session.updated, tabs));
    }
    for (const t of session.ungroupedTabs ?? []) {
      inner.push(bookmarkLine(t.url, t.title, t.savedAt, t.tags));
    }
    if (inner.length === 0) continue;
    const tags = [...(session.tags ?? [])];
    const block = folderBlock(session.name || 'Untitled Session', session.updated, inner.join(''));
    // TAGS de sesión se cuelgan del H3 como atributo extra (informativo).
    out.push(tags.length ? injectH3Tags(block, tags) : block);
  }

  out.push('</DL><p>\n');
  return out.join('');
}

/**
 * Añade TAGS="…" al <H3> de un bloque de carpeta ya generado.
 * @param {string} block @param {string[]} tags
 */
function injectH3Tags(block, tags) {
  return block.replace(/<H3 /, `<H3 TAGS="${esc(tags.join(','))}" `);
}
