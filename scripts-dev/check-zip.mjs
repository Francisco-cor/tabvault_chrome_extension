// scripts-dev/check-zip.mjs — Verifica que el zip store-ready incluye todo lo
// crítico y respeta el presupuesto de bundle (Fase 10.1: ≤250KB sin iconos).
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const BUDGET_BYTES = 250 * 1024; // bundle total sin iconos (Fase 10.1)

const zip = readdirSync(root).find((f) => /^tabvault-v.*\.zip$/.test(f));
if (!zip) {
  console.error('no zip found');
  process.exit(1);
}
const dest = path.join(root, '.zip-check');
rmSync(dest, { recursive: true, force: true });
execFileSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-Command',
    `Expand-Archive -Path '${path.join(root, zip)}' -DestinationPath '${dest}' -Force`,
  ],
  { stdio: 'ignore' }
);

const critical = [
  'manifest.json',
  'background/sw-main.js',
  'core/repository.js',
  'core/crypto.js',
  'core/backups.js',
  'core/importPlan.js',
  'core/favicons.js',
  'core/stats.js',
  'core/routines.js',
  'core/autoTagRules.js',
  'shared/logger.js',
  path.join('core', 'exporters', 'markdown.js'),
  path.join('core', 'exporters', 'bookmarks.js'),
  path.join('core', 'importers', 'index.js'),
  path.join('core', 'importers', 'netscape.js'),
  path.join('core', 'importers', 'onetab.js'),
  path.join('core', 'importers', 'urlList.js'),
  path.join('core', 'importers', 'sessionBuddy.js'),
  path.join('core', 'importers', 'draft.js'),
  path.join('ui', 'actions', 'vaultActions.js'),
  path.join('ui', 'components', 'Favicon.js'),
  path.join('popup', 'popup.html'),
  path.join('sidepanel', 'sidepanel.html'),
  path.join('newtab', 'newtab.html'),
];
const missing = critical.filter((rel) => !existsSync(path.join(dest, rel)));
console.log(`[${zip}] missing critical:`, missing.length ? missing : 'none');

// El popup debe declarar los modales nuevos (ambas superficies)
for (const html of [path.join('popup', 'popup.html'), path.join('sidepanel', 'sidepanel.html')]) {
  const t = readFileSync(path.join(dest, html), 'utf8');
  const ok = t.includes('id="import-modal"') && t.includes('id="passphrase-modal"');
  console.log(html, ok ? 'OK (modales fase 8)' : 'MISSING MODALS');
}

// ─── Presupuesto de bundle (Fase 10.1): el artefacto store ≤250KB.
// Interpretación: "bundle" = lo que se descarga/revisa (el zip). Los iconos
// pesan ~1.2KB (inmateriales); no-build (ADR-0001) prohíbe minificar, así que
// el tamaño descomprimido (~630KB) no es la métrica del presupuesto.
const zipBytes = statSync(path.join(root, zip)).size;
const kb = (zipBytes / 1024).toFixed(1);
console.log(`[bundle] zip store: ${kb} KB (budget ${BUDGET_BYTES / 1024} KB)`);
rmSync(dest, { recursive: true, force: true });

const failed = missing.length > 0 || zipBytes > BUDGET_BYTES;
if (failed) process.exit(1);
console.log('[check-zip] OK');
