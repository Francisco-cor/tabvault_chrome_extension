// ui/components/TagManager.js — Gestor global de tags (Fase 7.3).
// Lista todas las tags del vault con conteos por nivel y permite RENOMBRAR
// (equivale a fusionar si el destino ya existe), BORRAR con confirmación de dos
// pasos, todo vía repo.renameTag/deleteTag → propagación atómica single-writer.
// También lista los workspaces (@workspace:x) con las mismas operaciones:
// renombrar la tag-workspace ES renombrar el workspace (7.4).

import { Icon } from './Icon.js';
import { showToast } from '../actions/sessionActions.js';
import { collectTags, isWorkspaceTag, sessionWorkspace } from '../../core/organization.js';

/** @type {{ root: HTMLElement, cleanup: (()=>void)|null, ctx: any, opener: HTMLElement|null } | null} */
let active = null;

export function isTagManagerOpen() {
  return active !== null;
}

/**
 * Abre el gestor. Idempotente.
 * @param {any} ctx contexto compartido {store, repo, dom, renderer}
 */
export function openTagManager(ctx) {
  closeTagManager();
  const root = document.createElement('div');
  root.className = 'tm-overlay';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Manage tags');
  root.innerHTML = `
    <div class="tm-modal">
      <h3 class="modal-title">Manage tags</h3>
      <p class="modal-desc">
        Rename propagates everywhere — merging happens when the target already exists.
        Workspaces (<code>@workspace:name</code>) are managed here too.
      </p>
      <datalist id="tm-tag-options"></datalist>
      <div class="tm-rows" role="list"></div>
      <div class="tm-footer">
        <span class="text-dim" style="font-size:10.5px" id="tm-summary"></span>
        <button type="button" class="btn-secondary" data-tm="close">Close</button>
      </div>
    </div>`;
  document.body.appendChild(root);

  const inst = {
    root,
    cleanup: /** @type {(() => void)|null} */ (null),
    ctx,
    opener: document.activeElement instanceof HTMLElement ? document.activeElement : null,
  };
  active = inst;

  root.addEventListener('click', onRootClick);
  root.addEventListener('keydown', onKeydown);
  root.addEventListener('mousedown', (e) => {
    if (e.target === root) closeTagManager();
  });

  renderRows(root, ctx);
}

export function closeTagManager() {
  const inst = active;
  if (!inst) return;
  active = null;
  inst.cleanup?.();
  inst.root.remove();
  inst.opener?.focus?.({ preventScroll: true });
}

/** Repinta la lista desde el estado vivo. @param {HTMLElement} root @param {any} ctx */
function renderRows(root, ctx) {
  const sessions = ctx.store.getState().sessions;
  const rowsEl = /** @type {HTMLElement} */ (root.querySelector('.tm-rows'));
  const summary = /** @type {HTMLElement|null} */ (root.querySelector('#tm-summary'));
  const dl = /** @type {HTMLDataListElement|null} */ (root.querySelector('#tm-tag-options'));

  const tags = collectTags(sessions);
  if (dl) dl.innerHTML = tags.map((t) => `<option value="${esc(t.tag)}">`).join('');

  const wsCount = Object.values(sessions).filter((/** @type {any} */ s) => sessionWorkspace(s)).length;
  if (summary)
    summary.textContent = `${tags.length} tag${tags.length !== 1 ? 's' : ''} · ${wsCount} session${
      wsCount !== 1 ? 's' : ''
    } in workspaces`;

  rowsEl.innerHTML =
    tags.length === 0
      ? `<p class="text-muted" style="text-align:center;font-size:12px;padding:12px 0">
          No tags yet. Add them from a session's detail view.</p>`
      : tags.map((t) => rowHtml(t)).join('');
}

/** @param {{ tag: string, sessions: number, groups: number, tabs: number }} t */
function rowHtml(t) {
  const ws = isWorkspaceTag(t.tag);
  return `
  <div class="tm-row${ws ? ' tm-row-ws' : ''}" role="listitem" data-tag="${escAttr(t.tag)}">
    <span class="tm-icon">${Icon(ws ? 'grid' : 'doc', 11)}</span>
    <span class="tm-name">${esc(t.tag)}</span>
    <span class="tm-counts">${t.sessions}s · ${t.groups}g · ${t.tabs}t</span>
    <span class="tm-actions">
      <input type="text" class="tag-input tm-rename-input" list="tm-tag-options"
        maxlength="${Math.max(10, t.tag.length + 4)}" placeholder="new name…"
        aria-label="Rename ${escAttr(t.tag)}" hidden>
      <button type="button" class="btn-ghost" data-tm="rename" title="Rename or merge">${Icon('doc', 10)} Rename</button>
      <button type="button" class="btn-ghost btn-danger" data-tm="delete"
        title="Remove from every session, group and tab">${Icon('trash', 10)}</button>
    </span>
  </div>`;
}

/** Delegación única dentro del modal. @param {MouseEvent} e */
async function onRootClick(e) {
  if (!active) return;
  const target = /** @type {HTMLElement} */ (e.target);

  const btn = /** @type {HTMLElement|null} */ (target.closest('[data-tm]'));
  if (!btn) return;
  const action = btn.dataset.tm;
  if (action === 'close') return closeTagManager();

  const row = /** @type {HTMLElement|null} */ (target.closest('.tm-row'));
  if (!row) return;
  const tag = row.dataset.tag ?? '';

  if (action === 'rename') return startInlineRename(row, tag);
  if (action === 'delete') return deleteWithConfirm(row, tag);
}

/**
 * Renombrado inline: muestra input con datalist; Enter confirma, Esc cancela.
 * Confirmar con una tag existente = FUSIÓN (repo.renameTag deduplica).
 * @param {HTMLElement} row @param {string} tag
 */
function startInlineRename(row, tag) {
  const input = /** @type {HTMLInputElement|null} */ (row.querySelector('.tm-rename-input'));
  if (!input || !input.hidden) return;
  input.hidden = false;
  input.value = '';
  input.focus();

  /** @param {boolean} save */
  const finish = async (save) => {
    if (input.hidden) return;
    input.hidden = true;
    const inst = active;
    if (!save || !inst) return;
    const to = input.value.trim();
    if (!to || to === tag) return;
    const res = await inst.ctx.repo.renameTag(tag, to);
    showToast(
      inst.ctx,
      `Renamed → ${to} (${res.entities} item${res.entities !== 1 ? 's' : ''} updated)`,
      'success'
    );
    renderRows(inst.root, inst.ctx); // re-lista; el sync llega por onChanged aparte
  };

  input.onkeydown = (ev) => {
    if (ev.key === 'Enter') void finish(true);
    else if (ev.key === 'Escape') void finish(false);
  };
  input.onblur = () => void finish(false);
}

/**
 * Borrado en dos pasos: el primer click arma el botón ("Sure?"), el segundo
 * ejecuta. Click fuera o en otra cosa desarma.
 * @param {HTMLElement} row @param {string} tag
 */
async function deleteWithConfirm(row, tag) {
  const btn = /** @type {HTMLElement|null} */ (row.querySelector('[data-tm="delete"]'));
  const inst = active;
  if (!btn || !inst) return;
  if (btn.dataset.armed !== '1') {
    btn.dataset.armed = '1';
    btn.classList.add('armed');
    btn.insertAdjacentText('beforeend', ' Sure?');
    setTimeout(() => {
      if (btn.dataset.armed === '1') disarmDelete(btn);
    }, 3000);
    return;
  }
  disarmDelete(btn);
  const res = await inst.ctx.repo.deleteTag(tag);
  showToast(inst.ctx, `"${tag}" removed (${res.entities} item${res.entities !== 1 ? 's' : ''})`, 'success');
  renderRows(inst.root, inst.ctx);
}

/** @param {HTMLElement} btn */
function disarmDelete(btn) {
  delete btn.dataset.armed;
  btn.classList.remove('armed');
  // Quita el texto "Sure?" añadido (deja solo el icono + label base).
  const label = btn.lastChild;
  if (label && label.nodeType === Node.TEXT_NODE) label.textContent = ' ';
}

/** Enter/Escape globales del modal cuando no hay input inline enfocado. @param {KeyboardEvent} e */
function onKeydown(e) {
  if (e.key === 'Escape' && e.target instanceof HTMLInputElement && !e.target.hidden) return;
  if (e.key === 'Escape') closeTagManager();
}

/** @param {unknown} s */
function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** @param {unknown} s */
function escAttr(s) {
  return esc(s).replaceAll("'", '&#039;');
}
