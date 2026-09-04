// ui/components/GroupPills.js — Píldoras de preview de grupos de una sesión.

import { groupColorHex } from '../../shared/utils.js';
import { escapeHtml } from '../render.js';

/**
 * @param {import('../../shared/types.js').Session} session
 * @returns {string} html (cadena vacía si no hay grupos)
 */
export function GroupPills(session) {
  const groups = session.groups ?? [];
  if (groups.length === 0) return '';
  const pills = groups
    .slice(0, 5)
    .map(
      (g) => `
    <span class="group-pill">
      <span class="group-pill-dot" style="background:${groupColorHex(g.color)}"></span>
      ${escapeHtml(g.name || 'Untitled')}
    </span>`
    )
    .join('');
  const more = groups.length > 5 ? `<span class="group-pill text-muted">+${groups.length - 5}</span>` : '';
  return `<div class="session-groups-preview">${pills}${more}</div>`;
}
