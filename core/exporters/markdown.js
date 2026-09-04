// core/exporters/markdown.js — Export Markdown ENRIQUECIDO (Fase 8.2, fix M11).
// Sustituye al exportAsMarkdown que vivía en Repository (capa de presentación
// fuera de la capa de datos). Incluye: tags de sesión/grupo/tab, notas de
// sesión (via tags)/grupo/tab, flags, metadatos y conteos.

/** @typedef {import('../../shared/types.js').Session} Session */
/** @typedef {import('../../shared/types.js').Group} Group */
/** @typedef {import('../../shared/types.js').TabItem} TabItem */

/**
 * Escapa los caracteres que romperían un enlace/énfasis Markdown.
 * @param {string} s
 */
function mdText(s) {
  return String(s).replaceAll('[', '\\[').replaceAll(']', '\\]');
}

/** @param {string[]|undefined} tags */
function tagLine(tags) {
  return tags?.length ? `*Tags: ${tags.map(mdText).join(', ')}*\n` : '';
}

/** @param {string} note */
function noteLine(note) {
  if (!note) return '';
  return `${note
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n')}\n`;
}

/**
 * Fecha local legible sin depender de Intl extra.
 * @param {number} ts epoch ms
 */
function fmtDate(ts) {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

/**
 * @param {TabItem} tab
 */
function tabLine(tab) {
  const title = mdText(tab.title || tab.url);
  const flag = tab.pinned ? ' *(pinned)*' : '';
  let line = `- [${title}](${tab.url})${flag}\n`;
  line += noteLine(tab.note ?? '');
  line += tagLine(tab.tags);
  return line;
}

/**
 * @param {Group} group
 */
function groupSection(group) {
  const lines = [`## ${mdText(group.name || 'Untitled Group')}\n`];
  const meta = [
    group.color ? `\`${group.color}\`` : '',
    group.tags?.length ? `Tags: ${group.tags.join(', ')}` : '',
  ].filter(Boolean);
  if (meta.length) lines.push(`*${meta.join(' · ')}*\n`);
  lines.push(noteLine(group.note ?? ''));
  for (const t of group.tabs ?? []) lines.push(tabLine(t));
  lines.push('');
  return lines.join('\n');
}

/**
 * Convierte UNA sesión a Markdown enriquecido. Pura.
 * @param {Session} session
 * @returns {string}
 */
export function sessionToMarkdown(session) {
  const head = [`# ${mdText(session.name)}`, ''];
  /** @type {string[]} */
  const facts = [`Created: ${fmtDate(session.created)}`];
  if (session.updated && session.updated !== session.created)
    facts.push(`Updated: ${fmtDate(session.updated)}`);
  facts.push(`${session.metadata?.tabCount ?? 0} tabs · ${session.metadata?.groupCount ?? 0} groups`);
  head.push(`> ${facts.join(' · ')}`, '');
  head.push(tagLine(session.tags));
  /** @type {string[]} */
  const flags = [];
  if (session.pinned) flags.push('pinned');
  if (session.isTemplate) flags.push('template');
  if (session.autoSaved) flags.push('auto-saved');
  if (flags.length) head.push(`*Flags: ${flags.join(', ')}*\n`);

  for (const g of session.groups ?? []) head.push(groupSection(g));

  if (session.ungroupedTabs?.length) {
    head.push('## Ungrouped\n');
    for (const t of session.ungroupedTabs) head.push(tabLine(t));
    head.push('');
  }
  return (
    head
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd() + '\n'
  );
}
