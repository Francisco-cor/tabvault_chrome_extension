// ui/components/HoverPreview.js — Preview "rico" al mantener el hover sobre el
// split de restauración (Fase 6.2): grupos con color, nombre y conteo de tabs.
// Instancia única + timer con retardo; respeta reduced-motion vía CSS (fade).

import { groupColorHex } from '../../shared/utils.js';

/** @type {HTMLElement|null} */
let el = null;
let showTimer = /** @type {ReturnType<typeof setTimeout>|null} */ (null);
/** @type {(() => void)|null} */
let dismiss = null;

const SHOW_DELAY_MS = 550;

/**
 * Programa la aparición del preview. Llamar en mouseover del ancla.
 * @param {HTMLElement} anchor
 * @param {import('../../shared/types.js').Session|null} session
 */
export function scheduleHoverPreview(anchor, session) {
  cancelHoverPreview();
  if (!session) return;
  showTimer = setTimeout(() => {
    render(anchor, session);
  }, SHOW_DELAY_MS);
}

/** Cancela cualquier preview programado o visible (mouseout / click). */
export function cancelHoverPreview() {
  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = null;
  }
  hide();
}

function hide() {
  if (!el) return;
  const cleanup = dismiss;
  el.remove();
  el = null;
  dismiss = null;
  cleanup?.();
}

/** @param {HTMLElement} anchor @param {any} session */
function render(anchor, session) {
  hide();

  /** @type {any[]} */
  const groups = session.groups ?? [];
  const groupRows = groups
    .map(
      (/** @type {any} */ g) => `
    <div class="hover-preview-group">
      <span class="color-dot" style="background:${groupColorHex(g.color)}"></span>
      <span class="hover-preview-group-name">${escapeHtml(g.name || 'Untitled Group')}</span>
      <span class="hover-preview-count">${g.tabs?.length ?? 0}</span>
    </div>`
    )
    .join('');
  const ungroupedCount = session.ungroupedTabs?.length ?? 0;
  const ungroupedRow =
    ungroupedCount > 0
      ? `
    <div class="hover-preview-group">
      <span class="color-dot" style="background:transparent;border:1px dashed currentColor;opacity:.5"></span>
      <span class="hover-preview-group-name">Ungrouped</span>
      <span class="hover-preview-count">${ungroupedCount}</span>
    </div>`
      : '';

  el = document.createElement('div');
  el.className = 'hover-preview';
  el.setAttribute('role', 'tooltip');
  el.innerHTML = `
    <div class="hover-preview-title">${escapeHtml(session.name)}</div>
    ${groupRows}${ungroupedRow}
    <div class="hover-preview-total">${session.metadata?.tabCount ?? 0} tab${(session.metadata?.tabCount ?? 0) !== 1 ? 's' : ''} · ${groups.length} group${groups.length !== 1 ? 's' : ''}</div>`;

  document.body.appendChild(el);
  position(el, anchor);

  // Cualquier click (p.ej. abrir el menú de restauración) lo cierra.
  const onClickAway = () => hide();
  document.addEventListener('click', onClickAway, true);
  dismiss = () => document.removeEventListener('click', onClickAway, true);
}

/** @param {HTMLElement} node @param {HTMLElement} anchor */
function position(node, anchor) {
  const rect = anchor.getBoundingClientRect();
  const height = node.offsetHeight;
  node.style.top = Math.max(4, rect.bottom + 6 - height) + 'px';
  const width = node.offsetWidth;
  if (rect.right - width >= 0) node.style.right = window.innerWidth - rect.right + 'px';
  else node.style.left = rect.left + 'px';
}

/** @param {string} s */
function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
