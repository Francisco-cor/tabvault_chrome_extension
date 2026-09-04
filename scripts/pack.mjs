// scripts/pack.mjs — Empaqueta la extensión en un zip listo para la Chrome Web Store.
// Sin dependencias: usa Compress-Archive (Windows) o zip (Unix) sobre un staging limpio.
// Uso: npm run zip  →  tabvault-v<version>.zip

import { createRequire } from 'node:module';
import { cpSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const { version } = require(path.join(root, 'package.json'));

const RUNTIME_FILES = [
  'manifest.json',
  'background/',
  'popup/',
  'sidepanel/',
  'newtab/',
  'shared/',
  'core/',
  'ui/',
  'styles/',
  'icons/',
  'LICENSE',
];
const outZip = path.join(root, `tabvault-v${version}.zip`);
const stage = path.join(root, '.pack-stage');

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

for (const entry of RUNTIME_FILES) {
  const src = path.join(root, entry);
  if (!existsSync(src)) {
    console.warn(`[pack] aviso: no existe ${entry}, se omite`);
    continue;
  }
  if (entry.endsWith('/')) {
    cpSync(src, path.join(stage, entry), { recursive: true });
  } else {
    cpSync(src, path.join(stage, entry));
  }
}

const isWin = process.platform === 'win32';
if (isWin) {
  // PowerShell nativo; -Force sobrescribe
  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-Command', `Compress-Archive -Path '${stage}\\*' -DestinationPath '${outZip}' -Force`],
    { stdio: 'inherit' }
  );
} else {
  execFileSync('zip', ['-r', outZip, '.'], { cwd: stage, stdio: 'inherit' });
}

rmSync(stage, { recursive: true, force: true });

const sizeKb = Math.round(statSync(outZip).size / 102.4) / 10;
console.log(`[pack] OK → ${path.basename(outZip)} (${sizeKb} KB)`);
