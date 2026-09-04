// ui/actions/bulkActions.js — Operaciones en bloque: borrar (con undo), exportar y fusionar.

import { downloadText } from '../../shared/utils.js';
import { closeModal, openModal } from '../components/Modal.js';
import { showToast } from './sessionActions.js';
import { A } from '../actions.js';

/** @param {any} ctx @param {boolean} on */
export function setBulkMode(ctx, on) {
  ctx.store.dispatch({ type: A.BULK_MODE_TOGGLED, on });
}

/** @param {any} ctx @param {string} id */
export function toggleBulkCheck(ctx, id) {
  ctx.store.dispatch({ type: A.BULK_CHECK_TOGGLED, id });
}

/** @param {any} ctx */
export async function bulkDelete(ctx) {
  const state = ctx.store.getState();
  const ids = [...state.bulkSelected];
  if (ids.length === 0) return;
  const count = ids.length;

  await ctx.repo.deleteSessions(ids);
  ctx.store.dispatch({ type: A.BULK_CLEARED });

  ctx.undoToast.show(count + ' sessions deleted', async () => {
    for (const id of ids) {
      try {
        await ctx.repo.restoreFromTrash(id);
      } catch {
        /* algunas pueden haberse restaurado ya */
      }
    }
    showToast(ctx, count + ' sessions restored', 'success');
  });
}

/** @param {any} ctx */
export async function bulkExport(ctx) {
  const state = ctx.store.getState();
  /** @type {{ _tabvault: boolean, version: number, sessions: Record<string, any> }} */
  const exportData = { _tabvault: true, version: 2, sessions: {} };
  for (const id of state.bulkSelected) {
    const s = state.sessions[id];
    if (s) exportData.sessions[id] = s;
  }
  const n = Object.keys(exportData.sessions).length;
  if (n === 0) return;
  downloadText(JSON.stringify(exportData, null, 2), `tabvault-${n}-sessions.json`);
  ctx.store.dispatch({ type: A.BULK_CLEARED });
  showToast(ctx, `Exported ${n} sessions`, 'success');
}

/** @param {any} ctx */
export function openMergeModal(ctx) {
  const state = ctx.store.getState();
  if (state.bulkSelected.length < 2) {
    showToast(ctx, 'Select at least 2 sessions to merge', 'error');
    return;
  }
  const names = state.bulkSelected
    .map((/** @type {string} */ id) => state.sessions[id]?.name)
    .filter(Boolean);
  const desc = document.getElementById('merge-desc');
  const input = /** @type {HTMLInputElement|null} */ (document.getElementById('merge-name-input'));
  if (desc) desc.textContent = 'Merging: ' + names.join(', ');
  if (input) input.value = `Merged (${names.length} sessions)`;
  openModal('merge-modal');
}

export function closeMergeModal() {
  closeModal('merge-modal');
}

/** @param {any} ctx */
export async function confirmMerge(ctx) {
  const input = /** @type {HTMLInputElement|null} */ (document.getElementById('merge-name-input'));
  const name = input?.value.trim() || 'Merged Session';
  const ids = [...ctx.store.getState().bulkSelected];
  closeMergeModal();
  if (ids.length < 2) return;

  const merged = await ctx.repo.mergeSessions(ids, name);
  ctx.store.dispatch({ type: A.BULK_CLEARED });
  showToast(ctx, `Merged ${ids.length} sessions → "${merged.name}"`, 'success');
}
