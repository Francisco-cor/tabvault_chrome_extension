// ui/components/Onboarding.js — Overlay de bienvenida de 3 pasos (Fase 5.4).
// Se muestra una sola vez (settings.onboardingDone), es dismissible en cualquier
// punto y el flag persiste vía repo.saveSettings (single-writer).

/** Puro: ¿toca mostrar onboarding? (testeable sin DOM)
 * @param {{ onboardingDone?: boolean }|null} [settings]
 */
export function shouldShowOnboarding(settings) {
  return !(settings && settings.onboardingDone === true);
}

import { escapeHtml } from '../render.js';

const STEPS = [
  {
    icon: 'vault',
    title: 'Welcome to TabVault',
    text: 'Your tabs, saved as sessions. Capture everything open right now with one click and come back to it any time.',
  },
  {
    icon: 'search',
    title: 'Find anything instantly',
    text: 'Press / to search across every saved title, URL, note and tag. Restore a full session or a single tab.',
  },
  {
    icon: 'keyboard',
    title: 'Built for the keyboard',
    text: 'Navigate with j/k or arrows, Enter opens details, Shift+R restores with confirmation. Press ? any time to see all shortcuts.',
  },
];

/**
 * Muestra el overlay si corresponde. `finish` persiste el flag.
 * @param {any} ctx contexto {store, repo}
 * @param {() => Promise<void>} finish marca onboardingDone en settings
 */
export function maybeShowOnboarding(ctx, finish) {
  if (!shouldShowOnboarding(ctx.store.getState().settings)) return;
  showOnboarding(finish);
}

let visible = false;

export const isOnboardingOpen = () => visible;

/** @param {() => Promise<void>} finish */
function showOnboarding(finish) {
  if (visible || document.getElementById('onboarding')) return;
  let step = 0;
  visible = true;

  const root = document.createElement('div');
  root.className = 'onboarding-overlay';
  root.id = 'onboarding';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Welcome to TabVault');

  const render = () => {
    const s = STEPS[step];
    root.innerHTML = `
      <div class="onboarding-card">
        <div class="onboarding-icon">
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">${s.icon === 'vault' ? '<rect x="2" y="3" width="20" height="18" rx="3"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/>' : s.icon === 'search' ? '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>' : '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M18 13h.01M9 13h6M7 17h10"/>'}</svg>
        </div>
        <div class="onboarding-step">Step ${step + 1} of ${STEPS.length}</div>
        <div class="onboarding-title">${escapeHtml(s.title)}</div>
        <p class="onboarding-text">${escapeHtml(s.text)}</p>
        <div class="onboarding-dots" aria-hidden="true">
          ${STEPS.map((_, i) => `<span class="onboarding-dot${i === step ? ' active' : ''}"></span>`).join('')}
        </div>
        <div class="modal-actions" style="justify-content:space-between">
          <button type="button" class="btn-ghost" data-ob="skip">Skip</button>
          <button type="button" class="btn-primary" data-ob="next">${step === STEPS.length - 1 ? 'Get started' : 'Next'}</button>
        </div>
      </div>`;
  };
  render();

  /** Cierra y persiste el flag exactamente UNA vez. */
  const dismiss = () => {
    if (!visible) return;
    visible = false;
    root.remove();
    void finish();
  };

  root.addEventListener('click', (/** @type {MouseEvent} */ e) => {
    const btn = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-ob]'));
    if (!btn) {
      if (e.target === root) dismiss();
      return;
    }
    if (btn.dataset.ob === 'skip') dismiss();
    else if (step < STEPS.length - 1) {
      step += 1;
      render();
    } else dismiss();
  });

  document.body.appendChild(root);
}
