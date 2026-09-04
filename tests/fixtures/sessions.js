// tests/fixtures/sessions.js — Datos sintéticos deterministas para tests

import { randomUUID } from 'node:crypto';

/** Genera una tab válida.
 * @param {Partial<import('../../shared/types.js').TabItem>} [over]
 * @returns {import('../../shared/types.js').TabItem}
 */
export function makeTab(over = {}) {
  return {
    id: over.id ?? randomUUID(),
    url: 'https://example.com/page',
    title: 'Example page',
    favicon: '',
    note: '',
    tags: [],
    savedAt: 1_700_000_000_000,
    ...over,
  };
}

/** Genera un grupo válido.
 * @param {Partial<import('../../shared/types.js').Group>} [over]
 * @returns {import('../../shared/types.js').Group}
 */
export function makeGroup(over = {}) {
  return {
    id: over.id ?? randomUUID(),
    name: 'Group',
    color: 'purple',
    tags: [],
    note: '',
    tabs: [],
    ...over,
  };
}

/**
 * Sesión válida lista para guardar.
 * @param {Partial<import('../../shared/types.js').Session>} [over]
 * @returns {import('../../shared/types.js').Session}
 */
export function makeSession(over = {}) {
  const groups = over.groups ?? [];
  const ungroupedTabs = over.ungroupedTabs ?? [];
  return {
    id: over.id ?? randomUUID(),
    name: over.name ?? 'Session',
    created: over.created ?? 1_700_000_000_000,
    updated: over.updated ?? 1_700_000_000_000,
    groups,
    ungroupedTabs,
    metadata: over.metadata ?? {
      groupCount: groups.length,
      tabCount: groups.reduce((n, g) => n + g.tabs.length, 0) + ungroupedTabs.length,
    },
    ...over,
  };
}

/** Escenario estándar: dos sesiones, una con grupos y notas/tags, otra plana. */
export function seedScenario() {
  const work = makeSession({
    id: 'sess-work',
    name: 'Work',
    updated: 1_700_000_100_000,
    pinned: true,
    groups: [
      makeGroup({
        id: 'g-docs',
        name: 'Docs',
        color: 'blue',
        tags: ['work', 'docs'],
        note: 'project docs',
        tabs: [
          makeTab({ id: 't-1', url: 'https://docs.google.com/a', title: 'Doc A' }),
          makeTab({ id: 't-2', url: 'https://github.com/tabvault', title: 'Repo' }),
        ],
      }),
      makeGroup({
        id: 'g-mail',
        name: 'Mail',
        color: 'red',
        tags: ['comms'],
        tabs: [makeTab({ id: 't-3', url: 'https://mail.google.com', title: 'Gmail' })],
      }),
    ],
    ungroupedTabs: [
      makeTab({ id: 't-4', url: 'https://news.ycombinator.com', title: 'HN', note: 'read later' }),
    ],
  });

  const research = makeSession({
    id: 'sess-research',
    name: 'Research',
    updated: 1_700_000_200_000,
    groups: [
      makeGroup({
        id: 'g-papers',
        name: 'Papers',
        tags: ['research'],
        tabs: [
          makeTab({ id: 't-5', url: 'https://arxiv.org/abs/1234', title: 'Paper' }),
          makeTab({
            id: 't-6',
            url: 'https://github.com/x/y',
            title: 'Repo X',
            tags: ['code'],
          }),
        ],
      }),
    ],
    ungroupedTabs: [],
  });

  return { work, research };
}
