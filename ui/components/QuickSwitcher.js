// ui/components/QuickSwitcher.js — Paleta de comandos estilo VS Code (Fase 7.2).
// Un solo input busca SESIONES y TABS (vía el índice invertido) + COMANDOS.
// ↑↓ navegan, Enter ejecuta, Esc cierra; instancia única sobre document.body.
// Se abre con Ctrl+K en la UI y desde los comandos globales del SW vía intent.

import { searchVault } from '../../core/searchIndex.js';
import { Icon } from './Icon.js';
import { buildCommands, matchCommands } from '../services/commands.js';
import { truncateUrl } from '../../shared/utils.js';

/** @typedef {{ kind:'command', cmd:any } | { kind:'session', session:any } | { kind:'tab', tab:any, sessionId:string }} QsItem */

/** @type {{
 *   root: HTMLElement, input: HTMLInputElement, list: HTMLElement,
 *   items: QsItem[], sel: number, opener: HTMLElement|null, cleanup: (()=>void)|null,
 *   ctx: any, commands: any[]|null
 * } | null} */
let active = null;

/** ¿Está abierto? (para la cadena de Esc del bootstrap) */
export const isQuickSwitcherOpen = () => active !== null;

/**
 * Abre el switcher. Idempotente: reabrir con uno activo lo reinicia.
 * @param {any} ctx contexto compartido {store, router, repo, dom, …}
 * @param {{ query?: string }} [opts]
 */
export function openQuickSwitcher(ctx, opts = {}) {
  closeQuickSwitcher();
  const root = document.createElement('div');
  root.className = 'qs-overlay';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Quick Switcher');
  root.innerHTML = `
    <div class="qs-panel">
      <div class="qs-input-row">
        ${Icon('search', 13)}
        <input class="qs-input" type="text" placeholder="Search sessions, tabs, run a command…"
          autocomplete="off" spellcheck="false" aria-label="Quick switcher query">
        <kbd class="qs-kbd">Esc</kbd>
      </div>
      <ul class="qs-list" role="listbox" aria-label="Results"></ul>
    </div>`;
  document.body.appendChild(root);

  const inst = {
    root,
    input: /** @type {HTMLInputElement} */ (root.querySelector('.qs-input')),
    list: /** @type {HTMLElement} */ (root.querySelector('.qs-list')),
    items: [],
    sel: 0,
    opener: /** @type {HTMLElement|null} */ (
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    ),
    cleanup: /** @type {(() => void)|null} */ (null),
    ctx,
    commands: /** @type {any[]|null} */ (null),
  };
  active = inst;

  if (opts.query) inst.input.value = opts.query;

  inst.input.addEventListener('input', () => refresh());
  inst.input.addEventListener('keydown', onKeydown);
  root.addEventListener('mousedown', (e) => {
    if (e.target === root) closeQuickSwitcher();
  });
  inst.list.addEventListener('click', (e) => {
    const li = /** @type {HTMLElement|null} */ (
      /** @type {HTMLElement} */ (e.target).closest('[data-qs-index]')
    );
    if (!li || !active) return;
    active.sel = Number(li.dataset.qsIndex);
    void runSelected();
  });

  requestAnimationFrame(() => {
    inst.input.focus();
    refresh();
  });

  // Cierre por click fuera en fase captura (tick siguiente, patrón ContextMenu)
  setTimeout(() => {
    /** @param {MouseEvent} e */
    const handler = (e) => {
      if (!inst.root.contains(/** @type {Node} */ (e.target))) {
        closeQuickSwitcher();
        document.removeEventListener('mousedown', handler, true);
      }
    };
    document.addEventListener('mousedown', handler, true);
    inst.cleanup = () => document.removeEventListener('mousedown', handler, true);
  }, 0);
}

export function closeQuickSwitcher() {
  const inst = active;
  if (!inst) return;
  active = null;
  inst.cleanup?.();
  inst.root.remove();
  inst.opener?.focus?.({ preventScroll: true });
}

/** Recalcula resultados y repinta la lista. */
function refresh() {
  const inst = active;
  if (!inst?.input || !inst.list) return;
  const state = inst.ctx.store.getState();
  const q = inst.input.value.trim();

  // Comandos SIEMPRE disponibles (matchean label/hint/keywords).
  inst.commands ??= buildCommands(inst.ctx);
  /** @type {QsItem[]} */
  const cmds = matchCommands(/** @type {any[]} */ (inst.commands), q).map((cmd) => ({
    kind: 'command',
    cmd,
  }));
  setItems(q ? [...searchItems(state, q), ...cmds] : [...recentItems(state), ...cmds]);
}

/** Sin query: sesiones recientes. @param {any} state @returns {QsItem[]} */
function recentItems(state) {
  return Object.values(state.sessions)
    .sort((/** @type {any} */ a, /** @type {any} */ b) => b.updated - a.updated)
    .slice(0, 5)
    .map((/** @type {any} */ s) => ({ kind: 'session', session: s }));
}

/**
 * Con query: sesiones rankeadas por el índice + sus tabs matcheadas.
 * @param {any} state @param {string} q @returns {QsItem[]}
 */
function searchItems(state, q) {
  const found = searchVault(state.sessions, q, { now: state.now, limit: 12 });
  /** @type {QsItem[]} */
  const results = [];
  let tabQuota = 10;
  for (const s of found) {
    results.push({ kind: 'session', session: s });
    for (const m of (s._matchingTabs ?? []).slice(0, 4)) {
      if (tabQuota-- <= 0) break;
      results.push({
        kind: 'tab',
        tab: { ...m, title: m.title ?? '', url: m.url ?? '' },
        sessionId: s.id,
      });
    }
    if (results.length >= 24) break;
  }
  return results;
}

/** @param {QsItem[]} items */
function setItems(items) {
  if (!active || !active.list) return;
  active.items = items;
  active.sel = Math.min(active.sel, Math.max(0, items.length - 1));
  active.list.innerHTML = items
    .map((it, i) => {
      const groupStart = it.kind === 'command' && (i === 0 || items[i - 1].kind !== 'command');
      return rowHtml(it, i, groupStart ? ' qs-group-start' : '');
    })
    .join('');
  highlight();
}

/** @param {QsItem} it @param {number} i @param {string} [extraCls] */
function rowHtml(it, i, extraCls = '') {
  const cls = `qs-item${i === active?.sel ? ' active' : ''}${extraCls}`;
  const sel = i === active?.sel;
  if (it.kind === 'command') return commandRow(it.cmd, cls, i, sel);
  if (it.kind === 'session') return sessionRow(it.session, cls, i, sel);
  return tabRow(it.tab, cls, i, sel);
}

/** @param {any} cmd @param {string} cls @param {number} i @param {boolean} sel */
function commandRow(cmd, cls, i, sel) {
  return `<li class="${cls}" data-qs-index="${i}" role="option" aria-selected="${sel}">
    <span class="qs-kind">${Icon(cmd.icon, 11)}</span>
    <span class="qs-label">${esc(cmd.label)}</span>
    <span class="qs-hint">${esc(cmd.hint)}</span></li>`;
}

/** @param {any} s @param {string} cls @param {number} i @param {boolean} sel */
function sessionRow(s, cls, i, sel) {
  const hint = `${s.metadata?.tabCount ?? 0} tabs · ${esc(truncateUrl(topUrl(s), 26))}`;
  return `<li class="${cls}" data-qs-index="${i}" role="option" aria-selected="${sel}">
    <span class="qs-kind">${Icon('grid', 11)}</span>
    <span class="qs-label">${esc(s.name)}</span>
    <span class="qs-hint">${hint}</span></li>`;
}

/** @param {any} t @param {string} cls @param {number} i @param {boolean} sel */
function tabRow(t, cls, i, sel) {
  return `<li class="${cls} qs-item-tab" data-qs-index="${i}" role="option" aria-selected="${sel}">
    ${
      t.favicon
        ? `<img class="qs-fav" src="${esc(t.favicon)}" alt="" onerror="this.style.display='none'">`
        : `<span class="qs-kind">${Icon('doc', 11)}</span>`
    }
    <span class="qs-label">${esc(t.title || t.url)}</span>
    <span class="qs-hint">${esc(t._groupName ?? '')} ${esc(truncateUrl(t.url, 30))}</span></li>`;
}

/** Primera URL válida de una sesión (para el hint). @param {any} s */
function topUrl(s) {
  return s.ungroupedTabs?.[0]?.url || s.groups?.[0]?.tabs?.[0]?.url || '';
}

function highlight() {
  const inst = active;
  if (!inst?.list) return;
  inst.list.querySelectorAll('.qs-item').forEach((el, i) => {
    el.classList.toggle('active', i === inst.sel);
    el.setAttribute('aria-selected', String(i === inst.sel));
  });
  inst.list.children[inst.sel]?.scrollIntoView({ block: 'nearest' });
}

/** @param {KeyboardEvent} e */
function onKeydown(e) {
  if (!active) return;
  const max = active.items.length - 1;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    active.sel = max < 0 ? 0 : (active.sel + 1) % (max + 1);
    highlight();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    active.sel = max < 0 ? 0 : (active.sel - 1 + max + 1) % (max + 1);
    highlight();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    void runSelected();
  }
}

/** Ejecuta el ítem seleccionado y cierra. */
async function runSelected() {
  if (!active) return;
  const item = active.items[active.sel];
  const ctx = active.ctx;
  if (!item) return closeQuickSwitcher();

  if (item.kind === 'command') {
    closeQuickSwitcher();
    item.cmd.run(ctx);
    return;
  }
  if (item.kind === 'session') {
    closeQuickSwitcher();
    const sa = await import('../actions/sessionActions.js');
    await sa.restoreNewWindow(ctx, item.session.id);
    return;
  }
  // Tab: abrirla en una nueva tab del navegador.
  try {
    await chrome.tabs.create({ url: item.tab.url });
    closeQuickSwitcher();
  } catch {
    /* la URL pudo volverse inválida */
  }
}

/** @param {unknown} s */
function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
