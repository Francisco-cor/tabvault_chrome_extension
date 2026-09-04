// ui/components/TagChip.js — Chips de tag con botón opcional de quitar.

import { escapeHtml } from '../render.js';

/**
 * @param {string} tag
 * @param {{ active?: boolean, removable?: boolean, action?: string,
 *           data?: Record<string, string|number> }} cfg
 */
export function TagChip(tag, { active = false, removable = false, action, data = {} } = {}) {
  const attrs = Object.entries(data)
    .map(([k, v]) => ` data-${k}="${escapeHtml(String(v))}"`)
    .join('');
  const removeBtn = removable
    ? `<button class="tag-remove" data-action="${action}-remove"${attrs}>×</button>`
    : '';
  const clickAction = !removable && action ? ` data-action="${action}"` : '';
  return `
    <span class="tag-chip${active ? ' active' : ''}"${clickAction}${attrs}>
      ${escapeHtml(tag)}${removeBtn}
    </span>`;
}
