// ui/components/ShortcutsOverlay.js — Overlay de atajos de teclado (Fase 5.2).
// Se abre con '?' o desde el botón del header; se cierra con Esc/click fuera.
// Markup inyectado UNA vez y reutilizado (patrón igual al resto de overlays).

const SHORTCUTS = [
  ['Ctrl+K', 'Quick Switcher (sessions, tabs, commands)'],
  ['/', 'Focus search'],
  ['j / ↓', 'Next session'],
  ['k / ↑', 'Previous session'],
  ['Enter', 'Open detail'],
  ['Shift+R', 'Restore with confirmation'],
  ['Esc', 'Back / close'],
];

/** Atajos globales del navegador (chrome://extensions/shortcuts). */
const GLOBAL_SHORTCUTS = [
  ['Ctrl+Shift+S', 'Save current session'],
  ['Ctrl+Shift+X', 'Stash current tab'],
  ['Ctrl+Shift+P', 'Quick Switcher from anywhere'],
  ['Ctrl+Shift+F', 'Search saved tabs'],
  ['Alt+Shift+T', 'Toggle dark/light theme'],
];

/** @type {{ root: HTMLElement, panel: HTMLElement } | null} */
let inst = null;
/** @type {HTMLElement|null} */
let opener = null;

export const isShortcutsOpen = () => inst !== null;

export function toggleShortcuts() {
  if (inst) closeShortcuts();
  else openShortcuts();
}

export function openShortcuts() {
  if (inst) return;
  const root = document.createElement('div');
  root.className = 'help-overlay';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Keyboard shortcuts');
  root.innerHTML = `
    <div class="help-panel">
      <div class="help-title">Keyboard shortcuts</div>
      ${SHORTCUTS.map(
        ([keys, label]) =>
          `<div class="help-row"><span>${label}</span><span class="kbd-hint">${keys}</span></div>`
      ).join('')}
      <div class="help-title" style="margin-top:12px">Global (browser)</div>
      ${GLOBAL_SHORTCUTS.map(
        ([keys, label]) =>
          `<div class="help-row"><span>${label}</span><span class="kbd-hint">${keys}</span></div>`
      ).join('')}
    </div>`;
  document.body.appendChild(root);

  opener = /** @type {HTMLElement} */ (document.activeElement);
  root.addEventListener('click', (e) => {
    if (e.target === root) closeShortcuts();
  });

  inst = { root, panel: /** @type {HTMLElement} */ (root.firstElementChild) };
  // Foco inicial en el panel para que Esc/Tab vivan dentro del overlay.
  requestAnimationFrame(() => inst?.panel.setAttribute('tabindex', '-1'));
  inst.panel.focus({ preventScroll: true });
}

export function closeShortcuts() {
  if (!inst) return;
  inst.root.remove();
  inst = null;
  opener?.focus?.({ preventScroll: true });
  opener = null;
}
