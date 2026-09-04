// ui/actions/noteActions.js — Edición de notas con borradores en el store (M8).
// input  → despacha NOTE_DRAFT (el texto vive en el estado: cualquier re-render lo conserva)
//          y programa la persistencia con debounce 500ms.
// blur   → persistencia inmediata y limpieza del borrador.

import { A } from '../actions.js';
import { noteKey } from '../reducers.js';

/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const timers = new Map();
const DEBOUNCE_MS = 500;

/**
 * @param {any} ctx
 * @param {HTMLTextAreaElement} el
 */
export function onNoteInput(ctx, el) {
  const key = /** @type {string} */ (el.dataset.fk);
  ctx.store.dispatch({ type: A.NOTE_DRAFT, key, value: el.value });
  clearTimeout(timers.get(key));
  timers.set(
    key,
    setTimeout(() => {
      void persistDraft(ctx, el.dataset, el.value, true);
    }, DEBOUNCE_MS)
  );
}

/**
 * @param {any} ctx
 * @param {HTMLTextAreaElement} el
 */
export function onNoteBlur(ctx, el) {
  const key = /** @type {string} */ (el.dataset.fk);
  clearTimeout(timers.get(key));
  timers.delete(key);
  void persistDraft(ctx, el.dataset, el.value, true);
}

/**
 * Persiste una nota si cambió respecto al dato guardado.
 * @param {any} ctx
 * @param {DOMStringMap} ds dataset del textarea
 * @param {string} value
 * @param {boolean} clearDraft
 */
async function persistDraft(ctx, ds, value, clearDraft) {
  const sessionId = /** @type {string} */ (ds.sessionId);
  const groupId = ds.groupId || null;
  const tabId = ds.tabId || null;
  const state = ctx.store.getState();
  const session = state.sessions[sessionId];
  if (!session) return;

  const key = noteKey(sessionId, groupId, tabId);
  const changed = tabId
    ? applyTabNote(session, groupId, tabId, value)
    : applyGroupNote(session, groupId, value);

  if (!changed) {
    if (clearDraft && !timers.has(key)) ctx.store.dispatch({ type: A.NOTE_DRAFT_CLEARED, key });
    return;
  }

  await ctx.repo.updateSession(sessionId, {
    groups: session.groups,
    ungroupedTabs: session.ungroupedTabs,
  });

  if (clearDraft && !timers.has(key)) {
    // Solo limpiar si no llegó otra pulsación mientras se persistía
    ctx.store.dispatch({ type: A.NOTE_DRAFT_CLEARED, key });
  }
}

/**
 * Escribe la nota de una tab (mutación en memoria). true si cambió.
 * @param {any} session @param {string|null} groupId @param {string} tabId @param {string} value
 */
function applyTabNote(session, groupId, tabId, value) {
  let tab;
  if (groupId) {
    tab = session.groups
      ?.find((/** @type {any} */ g) => g.id === groupId)
      ?.tabs?.find((/** @type {any} */ t) => t.id === tabId);
  } else {
    tab = session.ungroupedTabs?.find((/** @type {any} */ t) => t.id === tabId);
  }
  if (!tab || tab.note === value) return false;
  tab.note = value;
  return true;
}

/**
 * Escribe la nota de un grupo (mutación en memoria). true si cambió.
 * @param {any} session @param {string|null} groupId @param {string} value
 */
function applyGroupNote(session, groupId, value) {
  const group = session.groups?.find((/** @type {any} */ g) => g.id === groupId);
  if (!group || group.note === value) return false;
  group.note = value;
  return true;
}
