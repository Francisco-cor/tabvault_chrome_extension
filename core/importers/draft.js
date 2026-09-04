// core/importers/draft.js — Modelo intermedio de los importadores de terceros
// y conversión a payload TabVault validado (Fase 8.2).
//
// Los parsers producen DRAFTS tolerantes (todo lo que se parezca a una tab);
// la sanitización REAL la hace core/schema.js vía normalizeSession — así ningún
// importador puede introducir una URL que el resto del pipeline no acepte.

import { newId } from '../domain.js';
import { normalizeSession } from '../schema.js';

/**
 * @typedef {Object} DraftTab
 * @property {string} url          SIN filtrar: schema.js decide si es segura
 * @property {string} [title]
 * @property {number} [savedAt]
 * @property {string[]} [tags]
 */
/**
 * @typedef {Object} DraftGroup
 * @property {string} name
 * @property {DraftTab[]} tabs
 */
/**
 * @typedef {Object} SessionDraft
 * @property {string} name
 * @property {number} [created]
 * @property {DraftGroup[]} [groups]
 * @property {DraftTab[]} [ungroupedTabs]
 */
/**
 * @typedef {Object} ParseResult
 * @property {SessionDraft[]} drafts
 * @property {boolean} truncated   se alcanzó un cap de seguridad
 */

export const MAX_IMPORT_TABS = 50_000;

/**
 * Convierte drafts en un payload con forma TabVault ({_tabvault:true,…}),
 * ya normalizado por schema.js. Puro.
 *
 * @param {SessionDraft[]} drafts
 * @returns {{ payload: Record<string, unknown>, warnings: string[] }}
 */
export function draftsToPayload(drafts) {
  /** @type {Record<string, any>} */
  const sessions = {};
  /** @type {string[]} */
  const warnings = [];
  let rawAnchors = 0;

  for (const draft of drafts ?? []) {
    rawAnchors += (draft.ungroupedTabs ?? []).length;
    for (const g of draft.groups ?? []) rawAnchors += g.tabs.length;
    if (!draft.name && rawAnchors === 0) continue;

    const norm = normalizeSession({
      id: newId(),
      name: draft.name || 'Imported session',
      created: draft.created ?? Date.now(),
      updated: draft.created ?? Date.now(),
      groups: draft.groups ?? [],
      ungroupedTabs: draft.ungroupedTabs ?? [],
    });
    if (!norm) continue; // inalcanzable con objeto en mano, pero TS lo exige
    sessions[norm.id] = norm;
  }

  let kept = 0;
  for (const s of Object.values(sessions)) kept += s.metadata.tabCount;
  const dropped = rawAnchors - kept;
  if (dropped > 0) {
    warnings.push(`${dropped} URL(s) inválidas o inseguras descartadas`);
  }
  if (Object.keys(sessions).length === 0) warnings.push('no usable content found');
  return { payload: { _tabvault: true, sessions }, warnings };
}

/**
 * Quita entidades HTML comunes de títulos de bookmarks. @param {string} s
 */
export function unescapeHtmlText(s) {
  return String(s)
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
}

/** epoch seg → ms (o 0 si no parsea). @param {unknown} v */
export function secToMs(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n * 1000) : 0;
}

/** epoch ms tolerante (acepta número o fecha ISO). @param {unknown} v @returns {number} */
export function looseMs(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v);
  if (typeof v === 'string') {
    const parsed = Date.parse(v);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}
