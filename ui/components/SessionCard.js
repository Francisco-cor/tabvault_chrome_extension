// ui/components/SessionCard.js — Tarjeta de sesión (vista Sessions y Trash).
// Fase 7: tags de nivel sesión visibles (click = filtrar), atributos de D&D
// para el orden manual (solo se emiten con sortBy=manual).

import { formatRelativeTime, formatDate } from '../../shared/utils.js';
import { Icon } from './Icon.js';
import { GroupPills } from './GroupPills.js';
import { escapeHtml } from '../render.js';

/**
 * @param {import('../../shared/types.js').Session} session
 * @param {{ bulkMode?: boolean, bulkSelected?: string[], trash?: boolean,
 *           now?: number, draggable?: boolean, cardIndex?: number }} [opts]
 */
export function SessionCard(
  session,
  { bulkMode = false, bulkSelected = [], trash = false, now, draggable = false, cardIndex } = {}
) {
  if (trash) return TrashCard(session, now);
  return VaultCard(session, { bulkMode, bulkSelected, now, draggable, cardIndex });
}

/** @param {any} session @param {number|undefined} now */
function TrashCard(session, now) {
  const id = escapeHtml(session.id);
  const tabCount = session.metadata?.tabCount ?? 0;
  return `
    <div class="session-card trash-card" data-id="${id}">
      <div class="session-card-header">
        <div class="session-card-info">
          <div class="session-name-row">
            <div class="session-name">${escapeHtml(session.name)}</div>
          </div>
          <div class="session-meta">
            <span class="meta-chip">${tabCount} tab${tabCount !== 1 ? 's' : ''}</span>
            <span class="meta-dot"></span>
            <span class="meta-chip">Deleted ${formatRelativeTime(session.deletedAt, now)}</span>
          </div>
        </div>
        <div class="session-card-actions" style="opacity:1">
          <button class="btn-ghost" data-action="restore-trash" data-id="${id}" title="Restore session">
            ${Icon('restore')}
            Restore
          </button>
          <button class="btn-ghost btn-danger" data-action="delete-permanent" data-id="${id}" title="Delete forever">
            ${Icon('trash')}
          </button>
        </div>
      </div>
    </div>`;
}

/**
 * Chips de metadatos: grupos · tabs · tiempo relativo.
 * @param {number} groupCount @param {number} tabCount @param {string} relTime @param {string} fullDate
 */
function metaChips(groupCount, tabCount, relTime, fullDate) {
  return `
            <span class="meta-chip">
              ${Icon('grid', 10)}
              ${groupCount} group${groupCount !== 1 ? 's' : ''}
            </span>
            <span class="meta-dot"></span>
            <span class="meta-chip">
              ${Icon('rows', 10)}
              ${tabCount} tab${tabCount !== 1 ? 's' : ''}
            </span>
            <span class="meta-dot"></span>
            <span class="meta-chip" title="${fullDate}">${relTime}</span>`;
}

/** Chips de estado junto al nombre: stash / auto / plantilla. @param {any} session */
function stateBadges(session) {
  const badges = [];
  if (session.stash) badges.push('<span class="auto-badge stash-badge">stash</span>');
  if (session.autoSaved) badges.push('<span class="auto-badge">auto</span>');
  if (session.isTemplate) {
    badges.push(
      `<span class="auto-badge template-badge" title="Template — restoring never marks it as used">${Icon('bookmark', 9, 'fill="currentColor" stroke-width="2"')}</span>`
    );
  }
  return badges.join('');
}

/** Botones de acción de la card. @param {any} session @param {string} id */
function cardActions(session, id) {
  const tplActive = session.isTemplate ? ' active' : '';
  const tplTitle = session.isTemplate ? 'Remove template mark' : 'Mark as template';
  const bookmarkFill = session.isTemplate ? 'fill="currentColor"' : 'fill="none"';
  return `
        <div class="session-card-actions">
          <div class="restore-split">
            <button class="btn-ghost" data-action="restore" data-id="${id}" title="Restore in new window">
              ${Icon('play')}
              Restore
            </button>
            <button class="btn-ghost restore-arrow" data-action="restore-menu" data-id="${id}" title="Restore options (incognito, copy URLs…)" aria-haspopup="menu">
              ${Icon('chevronDown', 8)}
            </button>
          </div>
          <button class="btn-ghost" data-action="detail" data-id="${id}" title="Notes &amp; tags">
            ${Icon('doc')}
          </button>
          <button class="btn-ghost${tplActive}" data-action="toggle-template" data-id="${id}"
            title="${tplTitle}" aria-pressed="${!!session.isTemplate}">
            ${Icon('bookmark', 12, bookmarkFill)}
          </button>
          <button class="btn-ghost" data-action="export-menu" data-id="${id}" title="Export">
            ${Icon('upload')}
          </button>
          <button class="btn-ghost btn-danger" data-action="delete" data-id="${id}" title="Delete">
            ${Icon('trash')}
          </button>
        </div>`;
}

/** Chips de tags de nivel sesión (Fase 7.3): click filtra por la tag. @param {any} session */
function sessionTags(session) {
  const tags = session.tags ?? [];
  if (tags.length === 0) return '';
  return `
    <div class="session-tags-row">
      ${tags
        .map(
          (/** @type {string} */ t) => `
        <button class="tag-filter-chip mini" data-action="toggle-filter-tag" data-tag="${escapeHtml(t)}"
          title="Filter sessions by this tag">${escapeHtml(t)}</button>`
        )
        .join('')}
    </div>`;
}

/** Checkbox de modo bulk. @param {any} session @param {boolean} bulkMode @param {string[]} bulkSelected */
function bulkCheckbox(session, bulkMode, bulkSelected) {
  if (!bulkMode) return '';
  const checked = bulkSelected.includes(session.id);
  return `
    <div class="bulk-check ${checked ? 'checked' : ''}" data-action="bulk-check" data-id="${escapeHtml(session.id)}">
      ${checked ? Icon('check', 10, 'stroke-width="3"') : ''}
    </div>`;
}

/**
 * @param {any} session
 * @param {{ bulkMode: boolean, bulkSelected: string[], now?: number,
 *           draggable?: boolean, cardIndex?: number }} opts
 */
function VaultCard(session, { bulkMode, bulkSelected, now, draggable, cardIndex }) {
  const groupCount = session.groups?.length ?? 0;
  const tabCount = session.metadata?.tabCount ?? 0;
  const relTime = formatRelativeTime(session.updated, now);
  const fullDate = formatDate(session.updated);
  const id = escapeHtml(session.id);

  const checkbox = bulkCheckbox(session, bulkMode, bulkSelected);
  const pinClass = session.pinned ? ' pinned' : '';
  const dragAttrs =
    draggable && !bulkMode ? ` draggable="true" data-card-index="${Number(cardIndex ?? -1)}"` : '';

  return `
    <div class="session-card" data-id="${id}" tabindex="0"${dragAttrs}>
      <div class="session-card-header">
        ${checkbox}
        <button class="pin-btn${pinClass}" data-action="pin" data-id="${id}" title="${session.pinned ? 'Unpin' : 'Pin to top'}">
          ${Icon('star', 12, `fill="${session.pinned ? 'currentColor' : 'none'}" stroke-width="2"`)}
        </button>
        <div class="session-card-info">
          <div class="session-name-row">
            <div class="session-name no-select" data-action="rename" data-id="${id}" title="Click to rename"
              data-fk="rename:${escapeHtml(session.id)}">${escapeHtml(session.name)}</div>
            ${stateBadges(session)}
          </div>
          <div class="session-meta">${metaChips(groupCount, tabCount, relTime, fullDate)}</div>
          ${sessionTags(session)}
        </div>
        ${cardActions(session, id)}
      </div>
      ${GroupPills(session)}
    </div>`;
}
