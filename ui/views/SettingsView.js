// ui/views/SettingsView.js — Preferencias (todas las settings normalizadas de Fases 2-7)
// + sección Data & backups (Fase 8): export multi-formato, ring-buffer restaurable
// y sincronización HONESTA (M10: solo preferencias, ADR-0003).

import { Icon } from '../components/Icon.js';
import { escapeHtml } from '../render.js';
import { formatRelativeTime } from '../../shared/utils.js';
import { nextRunAt } from '../../core/routines.js';

export const SettingsView = {
  deps: (/** @type {any} */ state) => [
    state.settings,
    state.backups,
    state.routines,
    state.autoTagRules,
    state.sessions,
  ],

  /** @param {any} state */
  render(state) {
    const s = state.settings ?? {};
    return `
    <div class="detail-back" data-action="back">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polyline points="15,18 9,12 15,6"/></svg>
      <span>Settings</span>
    </div>
    <div class="settings-panel">
      ${group(
        'Appearance',
        row(
          'Theme',
          'System follows your OS preference',
          select(
            'settings-theme',
            s.theme ?? 'dark',
            [
              ['dark', 'Dark'],
              ['light', 'Light'],
              ['system', 'System'],
            ],
            true,
            'Theme'
          )
        ) +
          row(
            'Accent color',
            'Used across buttons, focus and highlights',
            select(
              'settings-accent',
              s.accent ?? 'blue',
              [
                ['blue', 'Blue'],
                ['purple', 'Purple'],
                ['green', 'Green'],
                ['orange', 'Orange'],
              ],
              false,
              'Accent color'
            )
          )
      )}
      ${group(
        'Auto-save',
        row(
          'Periodic auto-save',
          'Saves all windows at a set interval',
          select(
            'settings-autosave',
            s.autoSaveMinutes,
            [
              ['0', 'Off'],
              ['5', 'Every 5 min'],
              ['15', 'Every 15 min'],
              ['30', 'Every 30 min'],
              ['60', 'Every hour'],
            ],
            false,
            'Periodic auto-save'
          )
        ) +
          row(
            'Auto-save on window close',
            "Rescues the window's tabs when it closes, with its groups",
            toggle('settings-autosave-close', s.autoSaveOnClose, 'Auto-save on window close')
          ) +
          row(
            'Include incognito windows',
            'Also capture incognito windows in auto-saves',
            toggle('settings-incognito', s.includeIncognito, 'Include incognito windows')
          ) +
          row(
            'Minimum tabs to auto-save',
            'Auto-saves below this tab count are skipped',
            select(
              'settings-min-tabs',
              s.minAutoSaveTabs,
              [1, 2, 3, 5, 10].map((n) => [String(n), `${n} tab${n > 1 ? 's' : ''}`]),
              false,
              'Minimum tabs to auto-save'
            )
          )
      )}
      ${group(
        'Saving',
        row(
          'Merge duplicate tabs',
          'When saving, tabs with the same URL are merged into one (keeps the newest title)',
          toggle('settings-dedupe-save', s.dedupeOnSave, 'Merge duplicate tabs')
        ) +
          row(
            'Duplicate session warning',
            'How similar a saved session must be before TabVault asks what to do',
            select(
              'settings-dup-threshold',
              s.dupThreshold,
              [
                ['50', '50% — very sensitive'],
                ['60', '60%'],
                ['70', '70%'],
                ['80', '80% — balanced'],
                ['90', '90%'],
                ['95', '95% — only near-identical'],
              ],
              false,
              'Duplicate session warning'
            )
          ) +
          excludedDomainsSection(s.excludedDomains ?? [])
      )}
      ${group(
        'Restore',
        row(
          'Focus existing tabs',
          'If a URL is already open in the target window, focus it instead of duplicating',
          toggle('settings-dedupe-restore', s.dedupeOnRestore, 'Focus existing tabs')
        )
      )}
      ${group(
        'Trash',
        row(
          'Purge automatically',
          'Permanently deletes trashed sessions older than the selected period',
          select(
            'settings-purge',
            s.trashPurgeDays,
            [
              ['7', '7 days'],
              ['30', '30 days'],
              ['60', '60 days'],
              ['90', '90 days'],
            ],
            false,
            'Purge automatically'
          )
        )
      )}
      ${group(
        'Sync',
        row(
          'Sync preferences across devices',
          'Only theme, sort and preferences travel via Chrome Sync. Sessions stay LOCAL on this device.',
          toggle('settings-sync', s.syncEnabled, 'Sync preferences across devices')
        )
      )}
      ${statsSection()}
      ${focusSection(s)}
      ${newTabSection(s)}
      ${historySection(s)}
      ${routinesSection(state)}
      ${autoTagSection(state)}
      ${dataAndBackups(state)}
      ${supportSection()}
      ${group(
        'Keyboard shortcuts',
        `<div class="settings-row" style="flex-direction:column;align-items:flex-start;gap:4px">
          ${kbd('/', 'Focus search')}
          ${kbd('? ', 'Shortcut overlay')}
          ${kbd('↑ ↓', 'Navigate sessions')}
          ${kbd('Enter', 'Open detail')}
          ${kbd('Shift+R', 'Restore with confirmation')}
          ${kbd('Esc', 'Go back / close')}
        </div>`
      )}
    </div>`;
  },
};

/** @param {string} title @param {string} body */
function group(title, body) {
  return `
      <div class="settings-group">
        <div class="settings-group-title">${escapeHtml(title)}</div>
        ${body}
      </div>`;
}

/**
 * @param {string} label @param {string} small @param {string} control
 */
function row(label, small, control) {
  return `
        <div class="settings-row">
          <div class="settings-label">
            ${escapeHtml(label)}
            <small>${escapeHtml(small)}</small>
          </div>
          ${control}
        </div>`;
}

/**
 * @param {string} id @param {number|string|undefined} current
 * @param {[string, string][]} options @param {boolean} [isString] comparar sin Number()
 * @param {string} [label] nombre accesible (axe: select-name)
 */
function select(id, current, options, isString = false, label = '') {
  const isSel = (/** @type {string} */ v) =>
    isString ? String(current) === v : Number(current) === Number(v);
  return `
          <select class="select" data-action="${id}" aria-label="${escapeHtml(label || id)}">
            ${options
              .map(
                ([value, label]) =>
                  `<option value="${value}" ${isSel(value) ? 'selected' : ''}>${label}</option>`
              )
              .join('')}
          </select>`;
}

/**
 * Gestor de dominios excluidos (Fase 6.1): se añaden desde el botón ⊘ del modal
 * de guardado; aquí se listan y eliminan.
 * @param {string[]} domains
 */
function excludedDomainsSection(domains) {
  const chips =
    domains.length === 0
      ? `<p class="text-muted" style="font-size:11px;margin:4px 0 0">
           None yet. Use the ⊘ button in the save dialog to always skip a domain.
         </p>`
      : `<div class="tag-filter-bar excluded-domains" style="margin-top:4px">
           ${domains
             .map(
               (d) => `
             <button class="tag-filter-chip active" data-action="remove-excluded-domain"
               data-domain="${escapeHtml(d)}" title="Stop skipping ${escapeHtml(d)}">
               ${escapeHtml(d)} ${Icon('x', 9)}
             </button>`
             )
             .join('')}
         </div>`;
  return `
          <div class="settings-row" style="flex-direction:column;align-items:flex-start;gap:2px">
            <div class="settings-label">
              Always-skipped domains
              <small>Unchecked automatically in the save dialog (${domains.length}/64)</small>
            </div>
            ${chips}
          </div>`;
}

/** @param {string} id @param {boolean|undefined} on */
/**
 * @param {string} id @param {boolean|undefined} on @param {string} [label] nombre accesible (axe: button-name)
 */
function toggle(id, on, label = '') {
  return `<button class="toggle-switch ${on ? 'on' : ''}" data-action="${id}" aria-pressed="${on ? 'true' : 'false'}" aria-label="${escapeHtml(label || id)}"></button>`;
}

const BACKUP_LABELS = /** @type {Record<string, string>} */ ({
  daily: 'Daily',
  manual: 'Manual',
  'pre-import': 'Pre-import',
  'pre-restore': 'Pre-restore',
});

/**
 * Sección Data & backups (Fase 8): export/import multi-formato + ring-buffer.
 * @param {any} state
 */
function dataAndBackups(state) {
  const b = state.backups ?? { daily: [], event: [] };
  const entries = [...(b.daily ?? []), ...(b.event ?? [])].sort(
    (/** @type {any} */ x, /** @type {any} */ y) => y.ts - x.ts
  );
  const list =
    entries.length === 0
      ? `<p class="text-muted" style="font-size:11px;margin:4px 0 0">
           No automatic backups yet. One is created daily while the browser runs.
         </p>`
      : `<div class="backup-list" role="list">
           ${entries
             .map(
               (/** @type {any} */ e) => `
             <div class="backup-row" role="listitem">
               <span class="backup-label backup-${escapeHtml(e.label)}">${BACKUP_LABELS[e.label] ?? escapeHtml(e.label)}</span>
               <span class="backup-meta" title="${new Date(e.ts).toLocaleString()}">
                 ${formatRelativeTime(e.ts, state.now)} · ${e.counts.sessions} sess · ${e.counts.tabs} tabs · ${Math.max(1, Math.round(e.size / 1024))} KB
               </span>
               <span class="backup-actions">
                 <button class="btn-ghost" data-action="backup-download" data-ts="${e.ts}" title="Download this backup as JSON">Save</button>
                 <button class="btn-ghost" data-action="backup-restore" data-ts="${e.ts}" title="Restore this point in time (current state is backed up first)">Restore</button>
                 <button class="btn-ghost btn-danger" data-action="backup-delete" data-ts="${e.ts}" title="Delete this backup">${Icon('x', 9)}</button>
               </span>
             </div>`
             )
             .join('')}
         </div>`;

  return `
  ${group(
    'Data',
    `
        <div class="settings-row" style="flex-direction:column;align-items:flex-start;gap:6px">
          <div class="settings-label">Portability
            <small>JSON backup · Bookmarks HTML · encrypted .tabvault.enc — from the toolbar buttons</small>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <button class="btn-secondary" data-action="export-data-json">Backup JSON</button>
            <button class="btn-secondary" data-action="export-data-bookmarks">Bookmarks HTML</button>
            <button class="btn-secondary" data-action="export-data-encrypted">Encrypted (.enc)</button>
          </div>
        </div>`
  )}
  ${group(
    'Backups',
    `<div class="settings-row" style="flex-direction:column;align-items:flex-start;gap:2px">
       <div class="settings-label">
         Automatic snapshots (7 daily · 3 event)
         <small>Saved locally without favicons. Restoring backs up the current state first.</small>
       </div>
       <button class="btn-secondary" data-action="backup-now" style="margin:4px 0 2px">Back up now</button>
       ${list}
     </div>`
  )}`;
}

function statsSection() {
  return group(
    'Dashboard',
    `<div class="settings-row">
       <div class="settings-label">Vault analytics<small>Sessions, domains, activity & repeats</small></div>
       <button class="btn-secondary" data-action="open-stats">${Icon('barChart', 11)} Open stats</button>
     </div>`
  );
}

/** Soporte local (Fase 10.5): informe de diagnóstico al portapapeles, sin red. */
function supportSection() {
  return group(
    'Support',
    `<div class="settings-row">
       <div class="settings-label">Copy diagnostics
         <small>Copies a local report (version, recent logs and errors) to your clipboard. Nothing leaves this browser.</small>
       </div>
       <button class="btn-secondary" data-action="copy-diagnostics">Copy report</button>
     </div>`
  );
}

/** @param {any} s */
function focusSection(s) {
  return group(
    'Focus & memory',
    row(
      'Suspend inactive tabs',
      'Close tabs inactive longer than this (kept in "Suspended" session)',
      select(
        'settings-suspend-hours',
        s.suspendHours,
        [
          ['1', '1 hour'],
          ['2', '2 hours'],
          ['4', '4 hours'],
          ['8', '8 hours'],
          ['24', '24 hours'],
        ],
        false,
        'Suspend inactive tabs'
      )
    ) +
      `<div class="settings-row">
         <div class="settings-label">Focus whitelist<small>Domains never closed by Focus mode (${(s.focusWhitelist ?? []).length}/64)</small></div>
         <div class="tag-filter-bar" style="margin-top:4px">
           ${(s.focusWhitelist ?? []).length === 0 ? '<span class="text-muted" style="font-size:11px">No whitelist yet. Add from session cards.</span>' : (s.focusWhitelist ?? []).map((/** @type {string} */ d) => `<button class="tag-filter-chip active" data-action="remove-focus-whitelist" data-domain="${escapeHtml(d)}">${escapeHtml(d)} ${Icon('x', 9)}</button>`).join('')}
         </div>
       </div>` +
      `<div class="settings-row" style="gap:6px">
         <button class="btn-secondary" data-action="suspend-now">${Icon('zap', 11)} Free memory now</button>
         <span class="text-muted" style="font-size:11px">Closes inactive tabs into "Suspended — today"</span>
       </div>`
  );
}

/** @param {any} s */
function newTabSection(s) {
  return group(
    'New tab',
    row(
      'Replace new tab page',
      'Show TabVault dashboard in every new tab (opt-in)',
      toggle('settings-newtab', s.newTabEnabled, 'Replace new tab page')
    )
  );
}

/** @param {any} s */
function historySection(s) {
  return group(
    'History',
    row(
      'Show recent history in search',
      'When enabled, searching also shows matches from your recent browser history (requires permission)',
      toggle('settings-history', s.historyEnabled, 'Show recent history in search')
    ) +
      (s.historyEnabled
        ? `<div class="settings-row"><div class="text-muted" style="font-size:11px">Permission "history" will be requested on next search if not granted.</div></div>`
        : '')
  );
}

/** @param {any} state */
function routinesSection(state) {
  const routines = state.routines ?? [];
  const sessions = Object.values(state.sessions ?? {});
  const opts = sessions.map((/** @type {any} */ v) => [
    v.id,
    `${v.name} (${v.metadata?.tabCount ?? 0} tabs)`,
  ]);
  const list =
    routines.length === 0
      ? '<p class="text-muted" style="font-size:11px;margin:4px 0 0">No routines yet. Schedule a session to open daily at a time.</p>'
      : `<div class="routine-list">
         ${routines
           .map((/** @type {any} */ r) => {
             const sess = state.sessions[r.sessionId];
             const name = sess ? sess.name : '(deleted session)';
             const next = nextRunAt(r.time, state.now);
             return `<div class="routine-row" data-routine-id="${escapeHtml(r.id)}">
                 <span class="routine-name">${escapeHtml(name)}</span>
                 <span class="routine-time">${escapeHtml(r.time)} → ${formatRelativeTime(next, state.now)}</span>
                 <button class="toggle-switch ${r.enabled ? 'on' : ''}" data-action="toggle-routine" data-id="${escapeHtml(r.id)}" aria-pressed="${r.enabled ? 'true' : 'false'}"></button>
                 <button class="btn-ghost btn-danger" data-action="delete-routine" data-id="${escapeHtml(r.id)}">${Icon('x', 9)}</button>
               </div>`;
           })
           .join('')}
       </div>`;
  const sessionOptions =
    opts.length === 0
      ? '<option value="">No sessions</option>'
      : opts.map(([id, label]) => `<option value="${escapeHtml(id)}">${escapeHtml(label)}</option>`).join('');
  return group(
    'Routines',
    `${list}
      <div class="routine-form" style="display:flex;gap:6px;margin-top:8px;align-items:center;flex-wrap:wrap">
        <select class="select" id="routine-session-select" aria-label="Session to schedule">${sessionOptions}</select>
        <input type="time" class="modal-input" id="routine-time-input" value="09:00" style="width:110px" aria-label="Routine time">
        <button class="btn-primary" data-action="add-routine">Schedule</button>
      </div>
     <small class="text-muted" style="font-size:11px;display:block;margin-top:4px">Opens the session daily ±1min via alarm; shows notification with Open / Incognito.</small>`
  );
}

/** @param {any} state */
function autoTagSection(state) {
  const rules = state.autoTagRules ?? [];
  const list =
    rules.length === 0
      ? '<p class="text-muted" style="font-size:11px;margin:4px 0 0">No auto-tag rules yet. Example: if URL contains "github.com" then tag "code".</p>'
      : `<div class="rules-list">
         ${rules
           .map(
             (/** @type {any} */ r) => `
           <div class="rule-row" data-rule-id="${escapeHtml(r.id)}">
             <span class="rule-pattern">if url contains <code>${escapeHtml(r.pattern)}</code> → <span class="tag-chip">${escapeHtml(r.tag)}</span></span>
             <button class="btn-ghost btn-danger" data-action="delete-rule" data-id="${escapeHtml(r.id)}">${Icon('x', 9)}</button>
           </div>`
           )
           .join('')}
       </div>`;
  return group(
    'Auto-tag rules',
    `${list}
     <div class="rule-form" style="display:flex;gap:6px;margin-top:8px;align-items:center;flex-wrap:wrap">
       <input type="text" class="modal-input" id="rule-pattern-input" placeholder="github.com" maxlength="120" style="width:150px">
       <span>→</span>
       <input type="text" class="modal-input" id="rule-tag-input" placeholder="code" maxlength="40" style="width:120px">
       <button class="btn-primary" data-action="add-rule">Add rule</button>
     </div>
     <div style="display:flex;gap:6px;margin-top:6px">
       <button class="btn-ghost" data-action="export-rules">Export JSON</button>
       <label class="btn-ghost" style="cursor:pointer">Import JSON<input type="file" id="import-rules-file" accept=".json" hidden></label>
     </div>`
  );
}

/** @param {string} keys @param {string} label */
function kbd(keys, label) {
  return `
           <div style="display:flex;gap:8px;align-items:center;width:100%">
             <span class="kbd-hint">${keys}</span>
             <span class="settings-label">${escapeHtml(label)}</span>
           </div>`;
}
