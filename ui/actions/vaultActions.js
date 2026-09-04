// ui/actions/vaultActions.js — Portabilidad de datos (Fase 8): export
// multi-formato (JSON / Markdown / Bookmarks / cifrado), import con preview y
// merge inteligente (8.1), respaldos automáticos (8.3) y recordatorio de export.
// El pipeline SIEMPRE re-valida en el SW (single-writer): la UI solo prepara.

import {
  downloadText,
  downloadBytes,
  readFileAsText,
  readFileAsArrayBuffer,
  sanitizeName,
} from '../../shared/utils.js';
import { showMenu } from '../components/ContextMenu.js';
import { openModal, closeModal } from '../components/Modal.js';
import { showToast } from './sessionActions.js';
import { Icon } from '../components/Icon.js';
import { A } from '../actions.js';
import { sessionToMarkdown } from '../../core/exporters/markdown.js';
import { sessionsToBookmarksHtml } from '../../core/exporters/bookmarks.js';
import { encryptWithPassphrase, decryptToText, looksEncrypted } from '../../core/crypto.js';
import { convertToPayload } from '../../core/importers/index.js';
import { validateImportPayload } from '../../core/schema.js';
import { planImport } from '../../core/importPlan.js';
import { shouldRemindExport } from '../../core/backups.js';
import { escapeHtml } from '../render.js';

/** Import en curso hasta confirmar/cancelar el preview. */
let pendingImport = /** @type {any|null} */ (null);

/** Resolver del modal de passphrase. */
let passphraseResolve = /** @type {((v: string|null) => void)|null} */ (null);

const IMPORT_MODAL = 'import-modal';
const PASSPHRASE_MODAL = 'passphrase-modal';

// ─── Export ──────────────────────────────────────────────────────────────────

/**
 * Backup JSON completo (comando del switcher y opción por defecto del header).
 * @param {any} ctx
 */
export async function exportAll(ctx) {
  const json = await ctx.repo.exportAll();
  downloadText(json, 'tabvault-backup.json');
  await markManualExport(ctx);
  showToast(ctx, 'Backup exported', 'success');
}

/** Menú de export global (header). @param {any} ctx @param {HTMLElement} anchor */
export function openExportMenu(ctx, anchor) {
  showMenu(anchor, [
    {
      label: 'Backup JSON',
      icon: Icon('upload', 11),
      action: () => void exportAll(ctx),
    },
    {
      label: 'Encrypted backup (.enc)',
      icon: Icon('eyeOff', 11),
      action: () => void exportEncrypted(ctx),
    },
    { divider: true },
    {
      label: 'Bookmarks HTML',
      icon: Icon('bookmark', 11),
      action: () => void exportBookmarksAll(ctx),
    },
  ]);
}

/** Export cifrado AES-GCM (.tabvault.enc). @param {any} ctx */
export async function exportEncrypted(ctx) {
  const passphrase = await askPassphrase(
    'Encrypt backup',
    'Choose a passphrase. Without it the backup cannot be recovered.'
  );
  if (!passphrase) return;
  try {
    const json = await ctx.repo.exportAll();
    const bytes = await encryptWithPassphrase(json, passphrase);
    const name = `tabvault-backup-${new Date().toISOString().slice(0, 10)}.tabvault.enc`;
    downloadBytes(bytes, name);
    await markManualExport(ctx);
    showToast(ctx, 'Encrypted backup exported', 'success');
  } catch (e) {
    showToast(ctx, 'Encryption failed: ' + msg(e), 'error');
  }
}

/** Todas las sesiones como Bookmarks HTML. @param {any} ctx */
export async function exportBookmarksAll(ctx) {
  const sessions = Object.values(ctx.store.getState().sessions);
  if (sessions.length === 0) return showToast(ctx, 'Nothing to export yet', 'error');
  downloadText(sessionsToBookmarksHtml(sessions), 'tabvault-bookmarks.html');
  await markManualExport(ctx);
  showToast(ctx, 'Bookmarks HTML exported', 'success');
}

/** Estampa settings.lastManualExport (recordatorio de Fase 8.3). @param {any} ctx */
async function markManualExport(ctx) {
  const settings = ctx.store.getState().settings ?? {};
  const patch = { ...settings, lastManualExport: Date.now() };
  ctx.store.dispatch({ type: A.SETTINGS_PATCHED, patch });
  await ctx.repo.saveSettings(patch);
}

// ─── Papelera ────────────────────────────────────────────────────────────────

/** @param {any} ctx @param {string} id */
export async function restoreFromTrash(ctx, id) {
  const session = await ctx.repo.restoreFromTrash(id);
  showToast(ctx, `"${session.name}" restored`, 'success');
}

let pendingDeleteId = /** @type {string|null} */ (null);

/** Modal de confirmación de borrado permanente. @param {any} ctx @param {string} id */
export function openDeleteModal(ctx, id) {
  pendingDeleteId = id;
  const session = ctx.store.getState().trash[id];
  const title = document.getElementById('delete-modal-title');
  const desc = document.getElementById('delete-modal-desc');
  if (title) title.textContent = 'Delete Permanently';
  if (desc) {
    desc.textContent =
      '"' + (session?.name ?? 'This session') + '" will be permanently deleted. This cannot be undone.';
  }
  openModal('delete-modal');
}

export function closeDeleteModal() {
  pendingDeleteId = null;
  closeModal('delete-modal');
}

/** @param {any} ctx */
export async function confirmDelete(ctx) {
  const id = pendingDeleteId;
  closeDeleteModal();
  if (!id) return;
  await ctx.repo.deletePermanently(id);
  showToast(ctx, 'Permanently deleted');
}

// ─── Export de sesión individual ─────────────────────────────────────────────

/** @param {any} ctx @param {HTMLElement} anchor @param {string} id */
export function showExportMenu(ctx, anchor, id) {
  const session = ctx.store.getState().sessions[id];
  if (!session) return;
  showMenu(anchor, [
    {
      label: 'Export JSON',
      action: async () => {
        const json = await ctx.repo.exportSession(id);
        downloadText(json, `${sanitizeName(session.name)}.json`);
        showToast(ctx, 'Exported as JSON', 'success');
      },
    },
    {
      label: 'Export Markdown',
      action: () => {
        // Fase 8.2: exporter enriquecido fuera de la capa de datos (M11).
        downloadText(sessionToMarkdown(session), `${sanitizeName(session.name)}.md`);
        showToast(ctx, 'Exported as Markdown', 'success');
      },
    },
    {
      label: 'Export Bookmarks HTML',
      action: () => {
        downloadText(sessionsToBookmarksHtml([session]), `${sanitizeName(session.name)}.html`);
        showToast(ctx, 'Exported as Bookmarks HTML', 'success');
      },
    },
  ]);
}

// ─── Import: menú y routing de archivos ──────────────────────────────────────

/** Menú de importación. @param {any} ctx @param {HTMLElement} anchor */
export function openImportMenu(ctx, anchor) {
  showMenu(anchor, [
    {
      label: 'TabVault backup (.json)',
      icon: Icon('download', 11),
      action: () => pickImportFile('.json,.tabvault', 'tabvault'),
    },
    {
      label: 'Encrypted backup (.enc)',
      icon: Icon('eyeOff', 11),
      action: () => pickImportFile('.enc', 'encrypted'),
    },
    { divider: true },
    {
      label: 'From bookmarks HTML',
      action: () => pickImportFile('.html,.htm', 'netscape'),
    },
    {
      label: 'From OneTab export',
      action: () => pickImportFile('.txt', 'onetab'),
    },
    {
      label: 'From Session Buddy',
      action: () => pickImportFile('.json', 'session-buddy'),
    },
    {
      label: 'From URL list',
      action: () => pickImportFile('.txt,.text', 'url-list'),
    },
  ]);
}

/**
 * Lanza el file input persistente con accept/kind dinámicos.
 * @param {string} accept @param {'tabvault'|'encrypted'|'netscape'|'onetab'|'url-list'|'session-buddy'} kind
 */
function pickImportFile(accept, kind) {
  const input = /** @type {HTMLInputElement|null} */ (document.getElementById('import-file'));
  if (!input) return;
  input.accept = accept;
  input.dataset.kind = kind;
  input.click();
}

/**
 * Handler del file input (enlazado una vez en el bootstrap).
 * @param {any} ctx @param {Event} e
 */
export async function onImportFileChange(ctx, e) {
  const input = /** @type {HTMLInputElement} */ (e.target);
  const file = input.files?.[0];
  const kind = /** @type {any} */ (input.dataset.kind ?? 'tabvault');
  input.value = '';
  delete input.dataset.kind;
  if (!file) return;

  try {
    if (kind === 'encrypted' || looksEncrypted(await sliceHead(file))) {
      const bytes = await readFileAsArrayBuffer(file);
      await importEncryptedFlow(ctx, bytes, file.name);
      return;
    }
    const text = await readFileAsText(file);
    if (kind === 'tabvault') {
      await handleTabVaultJson(ctx, text, file.name);
      return;
    }
    // Formatos extranjeros → payload TabVault → mismo camino validado.
    const converted = convertToPayload(kind, text);
    if (!converted) {
      showToast(ctx, 'Unrecognized file content for this format', 'error');
      return;
    }
    await handleTabVaultJson(ctx, JSON.stringify(converted.payload), file.name, [
      `Source: ${converted.format}`,
      ...converted.warnings,
    ]);
  } catch (err) {
    showToast(ctx, 'Import failed: ' + msg(err), 'error');
  }
}

/** Primeros 4 bytes para detectar magic TBVE sin leer todo el archivo.
 * @param {File} file */
function sliceHead(file) {
  return file.slice(0, 4).arrayBuffer();
}

/**
 * Descifra (con prompt) y reentra como backup TabVault.
 * @param {any} ctx @param {ArrayBuffer} bytes @param {string} filename
 */
async function importEncryptedFlow(ctx, bytes, filename) {
  // Reintento amigable: contraseña errónea no aborta el flujo.
  for (;;) {
    const passphrase = await askPassphrase('Decrypt backup', `Passphrase for "${filename}":`);
    if (!passphrase) return; // cancelado
    let text;
    try {
      text = await decryptToText(bytes, passphrase);
    } catch (err) {
      showPassphraseError(msg(err));
      continue;
    }
    await handleTabVaultJson(ctx, text, filename);
    return;
  }
}

/**
 * Camino común: valida el JSON TabVault, planifica el merge y abre el preview.
 * @param {any} ctx @param {string} text @param {string} filename @param {string[]} [preWarnings]
 */
export async function handleTabVaultJson(ctx, text, filename, preWarnings = []) {
  /** @type {any} */
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return showToast(ctx, 'Invalid JSON file', 'error');
  }
  const report = validateImportPayload(data);
  if (!report.ok) {
    return showToast(ctx, report.errors[0] ?? 'Not a valid TabVault export file', 'error');
  }

  const state = ctx.store.getState();
  const incoming = report.value.sessions ?? {};
  pendingImport = {
    filename,
    text,
    mode: 'merge',
    strategy: 'update',
    skipSimilar: true,
    warnings: [...preWarnings, ...report.errors],
    counts: {
      newSessions: planImport(incoming, state.sessions, state.settings?.dupThreshold ?? 80).fresh.length,
      total: Object.keys(incoming).length,
      trash: Object.keys(report.value.trash ?? {}).length,
      versions: Object.keys(report.value.versions ?? {}).length,
    },
    plan: planImport(incoming, state.sessions, state.settings?.dupThreshold ?? 80),
  };
  renderImportPreview();
  openModal(IMPORT_MODAL);
}

// ─── Preview modal (markup dinámico sobre shell estática) ────────────────────

/** Re-pinta el cuerpo del preview según pendingImport. */
export function renderImportPreview() {
  if (!pendingImport) return;
  const body = document.getElementById('import-modal-body');
  if (!body) return;

  const p = pendingImport;
  const similarNames = p.plan.similar
    .slice(0, 3)
    .map((/** @type {any} */ s) => `${escapeHtml(s.incomingName)} ≈ ${s.pct}%`)
    .join(', ');

  body.innerHTML = `
    <div class="import-source">
      <span class="import-filename">${escapeHtml(p.filename)}</span>
      <span class="text-muted">${escapeHtml(p.counts.total)} session(s) · ${escapeHtml(p.counts.trash)} trash · ${escapeHtml(p.counts.versions)} version set(s)</span>
    </div>
    ${warningsBlock(p)}
    <div class="import-options">
      ${modeRadio('merge', 'Merge with existing', 'recommended — nothing is deleted', p.mode)}
      ${modeRadio('replace', 'Replace everything', 'deletes current sessions first', p.mode)}
      <div id="import-merge-options" ${p.mode === 'merge' ? '' : 'hidden'}>
        ${collisionsBlock(p)}
        ${similarCheckbox(p, similarNames)}
      </div>
    </div>`;

  syncModalChrome();
}

/** @param {any} p */
function warningsBlock(p) {
  if (!p.warnings.length) return '';
  return `<ul class="import-warnings">${p.warnings
    .slice(0, 6)
    .map((/** @type {string} */ w) => `<li>${escapeHtml(w)}</li>`)
    .join('')}</ul>`;
}

/** @param {any} p */
function collisionsBlock(p) {
  if (p.plan.idCollisions.length === 0) return '';
  return `
    <div class="import-subhead">${p.plan.idCollisions.length} ID collision(s):</div>
    ${strategyRadio('update', 'Update existing sessions with incoming content', p.strategy)}
    ${strategyRadio('keep-both', 'Keep both (incoming gets a new ID)', p.strategy)}`;
}

/**
 * @param {any} p @param {string} similarNames
 */
function similarCheckbox(p, similarNames) {
  if (p.plan.similar.length === 0) return '';
  return `
    <label class="import-option sub">
      <input type="checkbox" id="import-skip-similar" ${p.skipSimilar ? 'checked' : ''}>
      <span>Skip ${p.plan.similar.length} session(s) already in the vault (${similarNames}${p.plan.similar.length > 3 ? '…' : ''})</span>
    </label>`;
}

/** @param {string} v @param {string} label @param {string} hint @param {string} current */
function modeRadio(v, label, hint, current) {
  return `
    <label class="import-option">
      <input type="radio" name="import-mode" value="${v}" ${current === v ? 'checked' : ''}>
      <span><strong>${label}</strong> <small>${hint}</small></span>
    </label>`;
}

/** @param {string} v @param {string} label @param {string} current */
function strategyRadio(v, label, current) {
  return `
    <label class="import-option sub">
      <input type="radio" name="import-collisions" value="${v}" ${current === v ? 'checked' : ''}>
      <span>${label}</span>
    </label>`;
}

/** Título/botón/visibilidad coherentes con pendingImport.mode. */
function syncModalChrome() {
  const isReplace = pendingImport?.mode === 'replace';
  const title = document.getElementById('import-modal-title');
  if (title) title.textContent = isReplace ? 'Replace all data?' : 'Import sessions';
  const btn = document.getElementById('import-confirm');
  if (btn) btn.textContent = isReplace ? 'Replace' : 'Merge';
  const mergeOpts = document.getElementById('import-merge-options');
  if (mergeOpts) mergeOpts.hidden = !isReplace;
}

/** Cambio de radios/checkbox dentro del preview (enlazado una vez desde main). */
export function onImportPreviewChange() {
  if (!pendingImport) return;
  const modeInput = /** @type {HTMLInputElement|null} */ (
    document.querySelector('#import-modal-body input[name="import-mode"]:checked')
  );
  if (modeInput) pendingImport.mode = /** @type {'merge'|'replace'} */ (modeInput.value);
  const strategyInput = /** @type {HTMLInputElement|null} */ (
    document.querySelector('#import-modal-body input[name="import-collisions"]:checked')
  );
  if (strategyInput) pendingImport.strategy = /** @type {'update'|'keep-both'} */ (strategyInput.value);
  const skip = /** @type {HTMLInputElement|null} */ (document.getElementById('import-skip-similar'));
  if (skip) pendingImport.skipSimilar = skip.checked;
  syncModalChrome();
}

export function closeImportModal() {
  pendingImport = null;
  closeModal(IMPORT_MODAL);
}

/** Ejecuta el import confirmado. @param {any} ctx */
export async function confirmImport(ctx) {
  const job = pendingImport;
  closeImportModal();
  if (!job) return;

  const skipIds =
    job.mode === 'merge' && job.skipSimilar
      ? job.plan.similar.map((/** @type {any} */ s) => s.incomingId)
      : [];
  try {
    const res = await ctx.repo.importAll(job.text, {
      mode: job.mode,
      strategy: job.strategy,
      skipIncomingIds: skipIds,
    });
    const parts =
      res.mode === 'replace'
        ? [`Restored ${res.imported} session(s)`]
        : [`+${res.added} new`, `${res.updated} updated`, `${res.skipped} skipped`];
    if (res.errors?.length) parts.push(`${res.errors.length} omitted`);
    showToast(ctx, parts.join(' · '), 'success');
  } catch (err) {
    showToast(ctx, 'Import failed: ' + msg(err), 'error');
  }
}

// ─── Passphrase modal (unlock + encrypt comparten shell estática) ────────────

/**
 * Pide una passphrase; resuelve string o null si cancela.
 * @param {string} title @param {string} desc
 * @returns {Promise<string|null>}
 */
export function askPassphrase(title, desc) {
  const t = document.getElementById('passphrase-modal-title');
  const d = document.getElementById('passphrase-desc');
  const input = /** @type {HTMLInputElement|null} */ (document.getElementById('passphrase-input'));
  const err = document.getElementById('passphrase-error');
  if (t) t.textContent = title;
  if (d) d.textContent = desc;
  if (err) err.setAttribute('hidden', '');
  if (input) input.value = '';
  openModal(PASSPHRASE_MODAL);
  requestAnimationFrame(() => input?.focus());
  return new Promise((resolve) => {
    passphraseResolve = resolve;
  });
}

/** @param {string} message */
export function showPassphraseError(message) {
  const err = document.getElementById('passphrase-error');
  if (err) {
    err.textContent = message;
    err.removeAttribute('hidden');
  }
  const input = /** @type {HTMLInputElement|null} */ (document.getElementById('passphrase-input'));
  input?.select();
}

export function submitPassphrase() {
  const input = /** @type {HTMLInputElement|null} */ (document.getElementById('passphrase-input'));
  const value = input?.value ?? '';
  if (!value.trim()) return showPassphraseError('A passphrase is required');
  closeModal(PASSPHRASE_MODAL);
  passphraseResolve?.(value);
  passphraseResolve = null;
}

export function cancelPassphrase() {
  closeModal(PASSPHRASE_MODAL);
  passphraseResolve?.(null);
  passphraseResolve = null;
}

/** Enter/Esc dentro del input (enlazado una vez desde main).
 * @param {KeyboardEvent} e */
export function passphraseKeydown(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    submitPassphrase();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    cancelPassphrase();
  }
}

// ─── Respaldos automáticos: UI de Settings (Fase 8.3) ────────────────────────

/** Carga el ring-buffer al store. @param {any} ctx */
export async function loadBackups(ctx) {
  try {
    const backups = await ctx.repo.getBackups();
    ctx.store.dispatch({ type: A.BACKUPS_SYNCED, backups });
  } catch {
    /* lectura best-effort */
  }
}

/** "Back up now". @param {any} ctx */
export async function createManualBackup(ctx) {
  try {
    const entry = await ctx.repo.createBackup('manual');
    showToast(ctx, entry ? 'Backup created' : 'Nothing to back up yet', 'success');
  } catch (e) {
    showToast(ctx, 'Backup failed: ' + msg(e), 'error');
  }
}

/** Descarga un backup como JSON. @param {any} ctx @param {HTMLElement} el */
export function downloadBackup(ctx, el) {
  const entry = findEntry(ctx, Number(el.dataset.ts));
  if (!entry) return;
  downloadText(
    JSON.stringify({ _tabvault: true, ...entry.data }, null, 2),
    `tabvault-${entry.label}-${entry.ts}.json`
  );
  showToast(ctx, 'Backup downloaded', 'success');
}

/** Restaurar punto en el tiempo (confirmación en dos pasos inline). @param {any} ctx @param {HTMLElement} el */
export function restoreBackupClick(ctx, el) {
  armConfirm(el, async () => {
    try {
      await ctx.repo.restoreBackup(Number(el.dataset.ts));
      showToast(ctx, 'Backup restored — undo available as newest backup', 'success');
    } catch (e) {
      showToast(ctx, 'Restore failed: ' + msg(e), 'error');
    }
  });
}

/** Borrar entrada de backup (dos pasos). @param {any} ctx @param {HTMLElement} el */
export function deleteBackupClick(ctx, el) {
  armConfirm(el, async () => {
    await ctx.repo.deleteBackup(Number(el.dataset.ts));
    showToast(ctx, 'Backup deleted', 'success');
  });
}

/** @param {any} ctx @param {number} ts */
function findEntry(ctx, ts) {
  const b = ctx.store.getState().backups ?? { daily: [], event: [] };
  return [...b.daily, ...b.event].find((e) => e.ts === ts) ?? null;
}

/** Confirmación destructiva en dos pasos con auto-desarme (patrón TagManager).
 * @param {HTMLElement} el @param {() => void} fire */
function armConfirm(el, fire) {
  if (el.dataset.armed === '1') {
    clearTimeout(Number(el.dataset.timer));
    delete el.dataset.armed;
    el.textContent = el.dataset.label ?? el.textContent;
    fire();
    return;
  }
  el.dataset.armed = '1';
  el.dataset.label = el.textContent ?? '';
  el.textContent = 'Sure?';
  el.dataset.timer = String(
    setTimeout(() => {
      delete el.dataset.armed;
      el.textContent = el.dataset.label ?? '';
    }, 3000)
  );
}

// ─── Recordatorio de export manual (banner dismissible) ──────────────────────

/**
 * ¿Mostrar el banner? Puro sobre el estado: ≥14 días sin export/dismiss
 * Y hay algo que proteger.
 * @param {any} state
 */
export function shouldShowExportReminder(state) {
  const s = state.settings;
  if (!s || Object.keys(state.sessions ?? {}).length === 0) return false;
  return shouldRemindExport(s.lastManualExport ?? 0, s.reminderDismissedAt ?? 0, state.now);
}

/** Dismiss del banner (+14 días de gracia). @param {any} ctx */
export async function dismissExportReminder(ctx) {
  const settings = ctx.store.getState().settings ?? {};
  const patch = { ...settings, reminderDismissedAt: Date.now() };
  ctx.store.dispatch({ type: A.SETTINGS_PATCHED, patch });
  await ctx.repo.saveSettings(patch);
}

/** @param {unknown} e @returns {string} */
function msg(e) {
  return e instanceof Error ? e.message : String(e);
}
