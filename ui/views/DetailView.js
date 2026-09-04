// ui/views/DetailView.js — Detalle de sesión: grupos/tags/notas editables, D&D,
// versiones y restauración PARCIAL con checkboxes por tab/grupo (Fase 6.2).
// Las notas renderizan PRIMERO el borrador en vuelo (state.notes) y luego lo persistido:
// un re-render provocado por un auto-save del SW nunca borra lo tecleado (M8).

import { groupColorHex, formatDate } from '../../shared/utils.js';
import { collectTags } from '../../core/organization.js';
import { TagChip } from '../components/TagChip.js';
import { Icon } from '../components/Icon.js';
import { favIconHtml } from '../components/Favicon.js';
import { escapeHtml, escapeAttr } from '../render.js';
import { noteKey } from '../reducers.js';

/**
 * Todas las tags conocidas del vault para el <datalist> de autocomplete.
 * Reusa el inventario del core. @param {any} state @returns {string[]}
 */
export function knownTags(state) {
  return collectTags(state.sessions).map((t) => t.tag);
}

/** Una sola definición por render; los inputs la referencian por id. @param {string[]} tags */
function tagDatalist(tags) {
  return `<datalist id="tv-tag-options">${tags
    .map((t) => `<option value="${escapeHtml(t)}">`)
    .join('')}</datalist>`;
}

export const DetailView = {
  deps: (/** @type {any} */ state) => [
    state.detailSessionId,
    state.sessions[state.detailSessionId ?? ''],
    state.showVersions,
    state.notes,
    state.detailUnchecked,
    state.versionsBySession[state.detailSessionId ?? ''],
    state.favicons,
  ],

  /** @param {any} state */
  render(state) {
    const session = state.sessions[state.detailSessionId ?? ''];
    if (!session) {
      return `<div class="empty-state"><h4>Session gone</h4><p>Back to sessions.</p></div>`;
    }

    const sid = escapeHtml(session.id);
    const groups = (session.groups ?? [])
      .map((/** @type {any} */ g, /** @type {number} */ i) => detailGroup(g, session.id, i, state))
      .join('');
    const ungrouped = session.ungroupedTabs ?? [];
    const ungroupedSection =
      ungrouped.length > 0
        ? `
    <div class="detail-group">
      <div class="detail-group-header">
        <span class="detail-group-name">Ungrouped</span>
        <span class="live-group-count">${ungrouped.length} tab${ungrouped.length !== 1 ? 's' : ''}</span>
      </div>
      ${ungrouped.map((/** @type {any} */ tab, /** @type {number} */ i) => detailTab(tab, null, session.id, i, state)).join('')}
    </div>`
        : '';

    const body =
      groups + ungroupedSection ||
      `<p class="text-muted" style="text-align:center;margin-top:24px;font-size:12px">No groups in this session.</p>`;

    return `
    ${tagDatalist(knownTags(state))}
    <div class="detail-back" data-action="back">
      ${Icon('arrowLeft', 14)}
      <span>${escapeHtml(session.name)}</span>
    </div>
    ${sessionTagsRow(session)}
    <div class="detail-toolbar">
      <button class="btn-secondary detail-add-tab" data-action="add-current-tab" data-session-id="${sid}">
        ${Icon('plus', 11)}
        Add current tab
      </button>
      <button class="btn-primary partial-open-btn" data-action="open-selected-tabs" title="Restore only the checked tabs">
        ${Icon('play', 11)}
        Open selected (${includedCount(session, state.detailUnchecked)})
      </button>
      <button class="btn-ghost" data-action="focus-session" data-session-id="${sid}" title="Focus: close everything except this session (undo 10s)">
        ${Icon('target', 11)}
        Focus
      </button>
      <button class="btn-ghost" data-action="toggle-versions" style="font-size:10.5px">
        ${Icon('clock', 11)}
        History
      </button>
    </div>
    ${state.showVersions ? versionsSection(state) : ''}
    ${body}`;
  },

  /**
   * Carga diferida de versiones cuando se abre History.
   * @param {any} ctx @param {any} state
   */
  after(ctx, state) {
    if (!state.showVersions || !state.detailSessionId) return;
    if (state.versionsBySession[state.detailSessionId]) return;
    ctx.loadVersions?.(state.detailSessionId);
  },
};

/**
 * Fila de tags de NIVEL SESIÓN (Fase 7.3): chips removibles + añadir con
 * autocomplete sobre las tags existentes del vault.
 * @param {any} session
 */
function sessionTagsRow(session) {
  const sid = escapeHtml(session.id);
  const chips = (session.tags ?? [])
    .map((/** @type {string} */ tag, /** @type {number} */ i) =>
      TagChip(tag, {
        removable: true,
        action: 'remove-session-tag',
        data: { 'session-id': session.id, 'tag-index': i },
      })
    )
    .join('');
  return `
  <div class="tags-row session-tags-row">
    ${chips}
    <input type="text" class="tag-input" list="tv-tag-options" maxlength="40"
      placeholder="+ session tag…" aria-label="Add session tag"
      data-action="add-session-tag-input" data-session-id="${sid}">
  </div>`;
}

/**
 * Tabs incluidas = total − desmarcadas. Puro (test).
 * @param {any} session @param {string[]} unchecked
 */
export function includedCount(session, unchecked) {
  if (!session) return 0;
  const all = [
    ...(session.ungroupedTabs ?? []),
    ...(session.groups ?? []).flatMap((/** @type {any} */ g) => g.tabs ?? []),
  ];
  if (unchecked.length === 0 || unchecked.length >= all.length) return all.length;
  return all.length - unchecked.filter((id) => all.some((t) => t.id === id)).length;
}

/**
 * Checkbox de restauración parcial. `unchecked` = ids DESmarcados.
 * @param {string} tabId @param {boolean} checked
 */
function partialCheck(tabId, checked) {
  return `<input type="checkbox" class="tab-check" data-action="detail-tab-check"
    data-tab-id="${escapeHtml(tabId)}" ${checked ? 'checked' : ''}
    aria-label="Include this tab when opening selected">`;
}

/**
 * @param {any} state
 */
function versionsSection(state) {
  const sid = state.detailSessionId;
  const versions = state.versionsBySession[sid];
  if (!versions) {
    return `<div class="version-list" id="version-list">
      <div class="text-muted" style="font-size:11px;text-align:center;padding:8px">Loading history…</div>
    </div>`;
  }
  if (versions.length === 0) {
    return `<div class="version-list" id="version-list">
      <div class="text-muted" style="font-size:11px;text-align:center;padding:8px">No version history yet. Versions are saved when you re-capture a session.</div>
    </div>`;
  }
  return `
  <div class="version-list" id="version-list">
    ${versions
      .map((/** @type {any} */ v, /** @type {number} */ i) => {
        const tabs = v.snapshot.metadata?.tabCount ?? 0;
        const groupsN = v.snapshot.metadata?.groupCount ?? 0;
        return `
      <div class="version-item">
        <div>
          <div class="version-date">${escapeHtml(formatDate(v.savedAt))}</div>
          <div class="version-meta">${groupsN} groups · ${tabs} tabs</div>
        </div>
        <button class="btn-ghost" data-action="restore-version" data-session-id="${escapeHtml(sid)}" data-version-index="${i}">Restore</button>
      </div>`;
      })
      .join('')}
  </div>`;
}

/**
 * Checkbox maestro del grupo (marca/desmarca todas sus tabs).
 * @param {any[]} tabs @param {string} groupId @param {string[]} unchecked
 */
function masterGroupCheck(tabs, groupId, unchecked) {
  if (!tabs || tabs.length === 0) return '';
  const checked = tabs.every((/** @type {any} */ t) => !unchecked.includes(t.id));
  return `<input type="checkbox" class="tab-check group-check" data-action="detail-group-check"
    data-group-id="${escapeHtml(groupId)}" ${checked ? 'checked' : ''}
    title="Select every tab in this group" aria-label="Toggle all tabs of the group">`;
}

/**
 * @param {any} group
 * @param {string} sessionId
 * @param {number} groupIndex
 * @param {any} state
 */
function detailGroup(group, sessionId, groupIndex, state) {
  const colorHex = groupColorHex(group.color);
  const sid = escapeHtml(sessionId);
  const gid = escapeHtml(group.id);
  const key = noteKey(sessionId, group.id, null);
  const draft = state.notes[key];
  const tags = (group.tags ?? [])
    .map((/** @type {string} */ tag, /** @type {number} */ i) =>
      TagChip(tag, {
        removable: true,
        action: 'remove-group-tag',
        data: { 'session-id': sessionId, 'group-id': group.id, 'tag-index': i },
      })
    )
    .join('');
  const tabs = group.tabs ?? [];

  return `
    <div class="detail-group" draggable="true" data-group-id="${gid}" data-group-index="${groupIndex}">
      <div class="detail-group-header" style="border-left:2px solid ${colorHex}">
        ${masterGroupCheck(tabs, group.id, state.detailUnchecked)}
        <span class="color-dot" style="background:${colorHex}"></span>
        <span class="detail-group-name">${escapeHtml(group.name)}</span>
        <span class="live-group-count">${group.tabs?.length ?? 0} tab${(group.tabs?.length ?? 0) !== 1 ? 's' : ''}</span>
        <button class="btn-ghost btn-danger detail-remove-group" data-action="remove-group"
          data-session-id="${sid}" data-group-id="${gid}" title="Remove group">
          ${Icon('trash', 11)}
        </button>
      </div>
      <div class="tags-row">
        ${tags}
        <button class="tag-add-btn" data-action="add-group-tag"
          data-session-id="${sid}" data-group-id="${gid}">+ tag</button>
      </div>
      <textarea class="note-area" placeholder="Group note…"
        data-action="note-group" data-session-id="${sid}" data-group-id="${gid}"
        data-fk="${escapeAttr(key)}"
        rows="2">${escapeHtml(draft ?? group.note ?? '')}</textarea>
      ${(group.tabs ?? []).map((/** @type {any} */ tab, /** @type {number} */ i) => detailTab(tab, group.id, sessionId, i, state)).join('')}
    </div>`;
}

/**
 * @param {any} tab
 * @param {string|null} groupId
 * @param {string} sessionId
 * @param {number} tabIndex
 * @param {any} state
 */
function detailTab(tab, groupId, sessionId, tabIndex, state) {
  const sid = escapeHtml(sessionId);
  const gid = groupId ? escapeHtml(groupId) : '';
  const key = noteKey(sessionId, groupId, tab.id);
  const draft = state.notes[key];
  const checked = !state.detailUnchecked.includes(tab.id);
  const tabTags = (tab.tags ?? [])
    .map((/** @type {string} */ tag, /** @type {number} */ i) =>
      TagChip(tag, {
        removable: true,
        action: 'remove-tab-tag',
        data: {
          'session-id': sessionId,
          'group-id': groupId ?? '',
          'tab-id': tab.id,
          'tag-index': i,
        },
      })
    )
    .join('');

  return `
    <div class="detail-tab" draggable="true" data-tab-id="${escapeHtml(tab.id)}" data-group-id="${gid}" data-tab-index="${tabIndex}">
      ${partialCheck(tab.id, checked)}
      ${favIconHtml(tab.url, state.favicons)}
      <div class="detail-tab-content">
        <div class="live-tab-title" title="${escapeHtml(tab.title)}">${escapeHtml(tab.title || tab.url)}</div>
        ${(tab.tags ?? []).length > 0 ? `<span class="tags-row tab-tags-row">${tabTags}</span>` : ''}
        <textarea class="note-area" style="min-height:26px;margin:3px 0 0;font-size:10.5px"
          placeholder="Tab note…"
          data-action="note-tab" data-session-id="${sid}"
          data-group-id="${gid}" data-tab-id="${escapeHtml(tab.id)}"
          data-fk="${escapeAttr(key)}"
          rows="1">${escapeHtml(draft ?? tab.note ?? '')}</textarea>
      </div>
      <span class="detail-tab-side">
        <button class="btn-ghost detail-tab-tag-btn" data-action="add-tab-tag"
          data-session-id="${sid}" data-group-id="${gid}" data-tab-id="${escapeHtml(tab.id)}"
          title="Add tag to this tab">${Icon('plus', 9)}</button>
        <button class="btn-ghost btn-danger detail-tab-remove" data-action="remove-tab"
          data-session-id="${sid}" data-group-id="${gid}" data-tab-id="${escapeHtml(tab.id)}"
          title="Remove tab">
          ${Icon('x', 10)}
        </button>
      </span>
    </div>`;
}
