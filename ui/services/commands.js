// ui/services/commands.js — Registro de comandos del Quick Switcher (Fase 7.2).
// Cada comando es {id,label,hint,icon,keywords?,run(ctx)}. Matching puro en
// matchCommands() para poder testear sin DOM.

import { openSaveModal } from '../actions/sessionActions.js';
import { toggleTheme } from '../actions/settingsActions.js';
import { exportAll } from '../actions/vaultActions.js';
import { openTagManager } from '../components/TagManager.js';

/**
 * @typedef {Object} CommandDef
 * @property {string} id
 * @property {string} label
 * @property {string} hint          texto gris de la derecha
 * @property {string} icon          nombre de Icon()
 * @property {string[]} [keywords]  sinónimos que también matchean
 * @property {(ctx: any) => void} run
 */

/**
 * Comandos disponibles en el switcher. El orden ES el ranking base.
 * @param {any} [_ctx] contexto compartido (reservado para comandos futuros)
 * @returns {CommandDef[]}
 */
export function buildCommands(_ctx) {
  return [
    {
      id: 'new-session',
      label: 'New session',
      hint: 'Capture current tabs',
      icon: 'plus',
      keywords: ['save', 'capture', 'guardar'],
      run: openSaveModal,
    },
    {
      id: 'go-sessions',
      label: 'Go to Sessions',
      hint: 'View',
      icon: 'grid',
      keywords: ['vault', 'list'],
      run: (c) => c.router.setRoot('sessions'),
    },
    {
      id: 'go-groups',
      label: 'Go to Live Groups',
      hint: 'View',
      icon: 'list',
      keywords: ['tabs', 'open'],
      run: (c) => c.router.setRoot('groups'),
    },
    {
      id: 'go-search',
      label: 'Go to Search',
      hint: 'View',
      icon: 'search',
      keywords: ['find'],
      run: (c) => c.router.setRoot('search'),
    },
    {
      id: 'go-trash',
      label: 'Go to Trash',
      hint: 'View',
      icon: 'trash',
      keywords: ['deleted', 'papelera'],
      run: (c) => c.router.setRoot('trash'),
    },
    {
      id: 'manage-tags',
      label: 'Manage tags',
      hint: 'Rename, merge or delete',
      icon: 'doc',
      keywords: ['tags', 'etiquetas', 'organize'],
      run: openTagManager,
    },
    {
      id: 'toggle-theme',
      label: 'Toggle dark / light theme',
      hint: 'Appearance',
      icon: 'star',
      keywords: ['dark', 'light', 'tema'],
      run: toggleTheme,
    },
    {
      id: 'open-settings',
      label: 'Open Settings',
      hint: 'Preferences',
      icon: 'settings',
      keywords: ['options', 'preferencias'],
      run: (c) => c.router.push('settings'),
    },
    {
      id: 'export-all',
      label: 'Export all data (JSON)',
      hint: 'Backup',
      icon: 'upload',
      keywords: ['backup', 'download', 'respaldo'],
      run: exportAll,
    },
  ];
}

/**
 * Matching puro de comandos contra una query: subsecuencia case-insensitive
 * sobre "label + hint + keywords". Conserva el orden base del registro.
 * @param {CommandDef[]} commands
 * @param {unknown} query
 */
export function matchCommands(commands, query) {
  const q = String(query ?? '')
    .trim()
    .toLowerCase();
  if (!q) return commands;
  return commands.filter((c) =>
    `${c.label} ${c.hint} ${(c.keywords ?? []).join(' ')}`.toLowerCase().includes(q)
  );
}
