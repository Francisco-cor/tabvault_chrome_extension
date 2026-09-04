// newtab/newtab.js — Minimal new-tab dashboard (Fase 9.6, opt-in).
// Reloj + últimas sesiones + buscador + rutinas. Lee directo de storage.local.

import { nextRunAt } from '../core/routines.js';

const clockEl = document.getElementById('newtab-clock');
const dateEl = document.getElementById('newtab-date');
const enabledEl = document.getElementById('newtab-enabled');
const disabledEl = document.getElementById('newtab-disabled');
const sessionsEl = document.getElementById('newtab-sessions');
const routinesEl = document.getElementById('newtab-routines');
const searchEl = document.getElementById('newtab-search');

function tick() {
  const now = new Date();
  if (clockEl) clockEl.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (dateEl)
    dateEl.textContent = now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
}
tick();
setInterval(tick, 60_000);

async function load() {
  const data = await chrome.storage.local.get(['settings', 'sessions', 'routines']);
  const settings = data.settings ?? {};
  const enabled = !!settings.newTabEnabled;
  if (enabledEl) enabledEl.hidden = !enabled;
  if (disabledEl) disabledEl.hidden = enabled;
  if (!enabled) return;

  const sessions = Object.values(data.sessions ?? {}).sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
  renderSessions(sessions);
  const routines = data.routines ?? [];
  renderRoutines(routines, data.sessions ?? {});
  if (searchEl) {
    searchEl.addEventListener('input', () => {
      const q = searchEl.value.trim().toLowerCase();
      if (!q) renderSessions(sessions);
      else
        renderSessions(
          sessions
            .filter((s) => s.name.toLowerCase().includes(q) || JSON.stringify(s).toLowerCase().includes(q))
            .slice(0, 8)
        );
    });
  }
}

function renderSessions(sessions) {
  if (!sessionsEl) return;
  if (sessions.length === 0) {
    sessionsEl.innerHTML = '<p class="text-muted" style="font-size:12px">No sessions yet.</p>';
    return;
  }
  sessionsEl.innerHTML = sessions
    .slice(0, 8)
    .map(
      (s) => `
    <div class="newtab-session">
      <span>${escapeHtml(s.name)} <small class="text-muted">· ${s.metadata?.tabCount ?? 0} tabs</small></span>
      <button class="btn-ghost" data-restore="${escapeHtml(s.id)}">Open</button>
    </div>`
    )
    .join('');
  sessionsEl.querySelectorAll('[data-restore]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = /** @type {HTMLElement} */ (btn).dataset.restore;
      await chrome.runtime.sendMessage({ type: 'RESTORE_SESSION', sessionId: id, mode: 'new' });
    });
  });
}

function renderRoutines(routines, sessions) {
  if (!routinesEl) return;
  if (!routines.length) {
    routinesEl.textContent = 'No routines yet. Create one in TabVault Settings → Routines.';
    return;
  }
  routinesEl.innerHTML = routines
    .map((r) => {
      const sess = sessions[r.sessionId];
      const name = sess ? sess.name : '(deleted)';
      const next = nextRunAt(r.time, Date.now());
      return `<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid var(--border)"><span>${escapeHtml(name)} <small class="text-muted">${escapeHtml(r.time)}</small></span><small class="text-muted">next ${escapeHtml(new Date(next).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</small></div>`;
    })
    .join('');
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

document
  .getElementById('open-settings')
  ?.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'OPEN_VAULT' }));
document
  .getElementById('nt-open-vault')
  ?.addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html') }));
document.getElementById('nt-save')?.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({
    type: 'CAPTURE_SESSION',
    name: `Session — ${new Date().toLocaleDateString()}`,
  });
});

load();
