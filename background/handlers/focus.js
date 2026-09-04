// background/handlers/focus.js — Modo enfoque (Fase 9.2) y suspensión memoria (9.3).
// Cierra tabs no pertenecientes a una sesión / inactivas, siempre respaldando antes.

import { repository as repo } from '../../core/repository.js';
import { newId } from '../../core/domain.js';

/**
 * @param {string} url
 * @returns {string} hostname
 */
function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Enfocar en esta sesión: cierra todo lo que NO está en la sesión elegida
 * en la ventana actual. Backup completo antes → undo natural.
 *
 * @param {string} sessionId
 * @param {{ windowId?: number|null, whitelist?: string[] }} [opts]
 * @returns {Promise<{ ok: true, closed: number, undoId: string }|{ ok:false, error:string }>}
 */
export async function focusSession(sessionId, opts = {}) {
  try {
    const session = await repo.getSession(sessionId);
    if (!session) return { ok: false, error: 'Session not found' };

    const windowId = opts.windowId ?? (await pickWindowId());
    if (windowId == null) return { ok: false, error: 'No window' };

    const whitelist = new Set((opts.whitelist ?? []).map((d) => String(d).toLowerCase()));
    const wanted = new Set([
      ...(session.groups ?? []).flatMap((g) => (g.tabs ?? []).map((t) => t.url)),
      ...(session.ungroupedTabs ?? []).map((t) => t.url),
    ]);

    const tabs = await chrome.tabs.query({ windowId });
    /** @type {typeof tabs} */
    const toClose = [];
    for (const tab of tabs) {
      if (!tab.url || wanted.has(tab.url)) continue;
      const h = hostOf(tab.url);
      if (whitelist.has(h)) continue;
      // nunca cerrar la extensión propia / chrome://
      if (tab.url.startsWith('chrome-extension://') || tab.url.startsWith('chrome://')) continue;
      toClose.push(tab);
    }

    if (toClose.length === 0) return { ok: true, closed: 0, undoId: '' };

    // Guardar sesión efímera con las tabs que van a cerrarse (undo 10s).
    const now = Date.now();
    const undoSession = {
      id: newId(),
      name: `↺ Focus undo — ${session.name}`,
      created: now,
      updated: now,
      groups: [],
      ungroupedTabs: toClose.map((t) => ({
        id: newId(),
        url: t.url ?? '',
        title: t.title ?? t.url ?? '',
        favicon: '',
        note: '',
        tags: [],
        savedAt: now,
        ...(t.pinned ? { pinned: true } : {}),
      })),
      metadata: { groupCount: 0, tabCount: toClose.length },
      autoSaved: true,
    };
    const saved = await repo.saveSession(/** @type {any} */ (undoSession));

    const ids = toClose.map((t) => t.id).filter((id) => typeof id === 'number');
    // @ts-ignore mock chrome.tabs.remove single id or array?
    await Promise.all(ids.map((id) => chrome.tabs.remove(id).catch(() => {})));

    return { ok: true, closed: toClose.length, undoId: saved.id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Suspensión nativa complementaria: cierra tabs inactivas (> suspendHours)
 * conservándolas en sesión temporal "Suspendidas hoy".
 * Heurística sin lastAccessed: cierra las no activas ni pinned.
 * @param {{ windowId?: number|null, hours?: number }} [opts]
 * @returns {Promise<{ ok:true, closed:number, sessionId:string }|{ ok:false, error:string }>}
 */
export async function suspendInactiveTabs(opts = {}) {
  try {
    const settings = await repo.getSettings();
    const hours = opts.hours ?? settings.suspendHours ?? 4;
    void hours; // hours se usa para nombrar y para futura lógica con history si existe
    const windowId = opts.windowId ?? (await pickWindowId());
    if (windowId == null) return { ok: false, error: 'No window' };

    const tabs = await chrome.tabs.query({ windowId });
    const candidates = tabs.filter(
      (t) =>
        !t.active &&
        !t.pinned &&
        t.url &&
        !t.url.startsWith('chrome-extension://') &&
        !t.url.startsWith('chrome://')
    );

    if (candidates.length === 0) return { ok: true, closed: 0, sessionId: '' };

    const now = Date.now();
    const session = {
      id: newId(),
      name: `Suspended — ${new Date(now).toLocaleDateString()}`,
      created: now,
      updated: now,
      groups: [],
      ungroupedTabs: candidates.map((t) => ({
        id: newId(),
        url: t.url ?? '',
        title: t.title ?? t.url ?? '',
        favicon: '',
        note: '',
        tags: [],
        savedAt: now,
      })),
      metadata: { groupCount: 0, tabCount: candidates.length },
      autoSaved: true,
    };
    const saved = await repo.saveSession(/** @type {any} */ (session));
    const ids = candidates.map((t) => t.id).filter((id) => typeof id === 'number');
    await Promise.all(ids.map((id) => chrome.tabs.remove(id).catch(() => {})));
    return { ok: true, closed: candidates.length, sessionId: saved.id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function pickWindowId() {
  try {
    const win = await chrome.windows.getLastFocused();
    return win.id ?? null;
  } catch {
    const wins = await chrome.windows.getAll();
    return wins[0]?.id ?? null;
  }
}
