// ui/views/TrashView.js — Papelera (la purga periódica corre en el SW desde Fase 2).

import { SessionCard } from '../components/SessionCard.js';
import { Icon } from '../components/Icon.js';

export const TrashView = {
  deps: (/** @type {any} */ state) => [state.trash, Math.floor(state.now / 60000)],

  /** @param {any} state */
  render(state) {
    const items = Object.values(state.trash).sort(
      (/** @type {any} */ a, /** @type {any} */ b) => b.deletedAt - a.deletedAt
    );
    if (items.length === 0) {
      return `
      <div class="empty-state">
        ${Icon('trash', 44, 'class="empty-icon" stroke-width="1.2"')}
        <h4>Trash is empty</h4>
        <p>Deleted sessions are kept here for a configurable period.</p>
      </div>`;
    }

    return items.map((/** @type {any} */ s) => SessionCard(s, { trash: true, now: state.now })).join('');
  },
};
