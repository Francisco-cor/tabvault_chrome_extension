// tests/ui/fase8.test.js — Fase 8 en UI: banner de recordatorio de export,
// sección Data & backups de Settings y reducer del ring-buffer.
import { describe, it, expect } from 'vitest';
import { SessionsView } from '../../ui/views/SessionsView.js';
import { SettingsView } from '../../ui/views/SettingsView.js';
import { rootReducer, initialState } from '../../ui/reducers.js';
import { makeSession } from '../fixtures/sessions.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 22);

/** Estado mínimo para SessionsView.render. */
function baseState(over = {}) {
  return {
    sessions: {},
    liveGroups: [],
    liveUngrouped: [],
    filterTags: [],
    templatesOnly: false,
    sortBy: 'newest',
    bulkMode: false,
    bulkSelected: [],
    workspace: '',
    activeFilters: { domain: '', range: 'any', pinnedOnly: false },
    now: NOW,
    settings: {
      theme: 'dark',
      accent: 'blue',
      sortBy: 'newest',
      lastManualExport: 0,
      reminderDismissedAt: 0,
    },
    ...over,
  };
}

describe('SessionsView — banner de recordatorio (8.3)', () => {
  it('sin export hace >14 días Y con sesiones → banner visible con acciones', () => {
    const state = baseState({
      sessions: { s1: makeSession({ id: 's1', created: NOW - DAY, updated: NOW - DAY }) },
      settings: { ...baseState().settings, lastManualExport: NOW - 20 * DAY },
    });
    const html = SessionsView.render(state);
    expect(html).toContain('export-reminder');
    expect(html).toContain('data-action="export-from-reminder"');
    expect(html).toContain('data-action="dismiss-export-reminder"');
    expect(html).toContain('last export');
  });

  it('nunca exportado → banner con "never exported"', () => {
    const state = baseState({
      sessions: { s1: makeSession({ id: 's1' }) },
      settings: { ...baseState().settings, lastManualExport: 0 },
    });
    expect(SessionsView.render(state)).toContain('never exported');
  });

  it('vault vacío o export reciente → sin banner', () => {
    expect(SessionsView.render(baseState())).not.toContain('export-reminder');
    const recent = baseState({
      sessions: { s1: makeSession() },
      settings: { ...baseState().settings, lastManualExport: NOW - 3 * DAY },
    });
    expect(SessionsView.render(recent)).not.toContain('export-reminder');
  });

  it('dismiss reciente silencia aunque el export sea antiguo', () => {
    const dismissed = baseState({
      sessions: { s1: makeSession() },
      settings: {
        ...baseState().settings,
        lastManualExport: NOW - 60 * DAY,
        reminderDismissedAt: NOW - 2 * DAY,
      },
    });
    expect(SessionsView.render(dismissed)).not.toContain('export-reminder');
  });
});

describe('SettingsView — Data & backups (8)', () => {
  const state = () => ({
    now: NOW,
    settings: { theme: 'dark', accent: 'blue', syncEnabled: false },
    backups: {
      daily: [
        { label: 'daily', ts: 1000, size: 2048, counts: { sessions: 3, tabs: 40, trash: 1 }, data: {} },
      ],
      event: [
        { label: 'pre-import', ts: 2000, size: 512, counts: { sessions: 1, tabs: 2, trash: 0 }, data: {} },
        { label: 'pre-restore', ts: 3000, size: 512, counts: { sessions: 0, tabs: 0, trash: 0 }, data: {} },
      ],
    },
  });

  it('lista ambos anillos ordenados por fecha descendente con acciones', () => {
    const html = SettingsView.render(state());
    expect(html.match(/backup-row/g)?.length).toBe(3);
    // descendente por ts
    const positions = ['data-ts="3000"', 'data-ts="2000"', 'data-ts="1000"'].map((needle) =>
      html.indexOf(needle)
    );
    expect(positions[0]).toBeGreaterThan(-1);
    expect(positions[0]).toBeLessThan(positions[1]);
    expect(positions[1]).toBeLessThan(positions[2]);
    expect(html).toContain('data-action="backup-restore"');
    expect(html).toContain('data-action="backup-download"');
    expect(html).toContain('data-action="backup-delete"');
    expect(html).toContain('data-action="backup-now"');
  });

  it('etiquetas legibles por tipo de backup', () => {
    const html = SettingsView.render(state());
    expect(html).toContain('>Daily</span>');
    expect(html).toContain('>Pre-import</span>');
    expect(html).toContain('>Pre-restore</span>');
  });

  it('botones de export multi-formato presentes', () => {
    const html = SettingsView.render(state());
    expect(html).toContain('data-action="export-data-json"');
    expect(html).toContain('data-action="export-data-bookmarks"');
    expect(html).toContain('data-action="export-data-encrypted"');
  });

  it('M10: el copy de Sync declara que las sesiones NO viajan', () => {
    const html = SettingsView.render(state());
    expect(html).toContain('Sync preferences across devices');
    expect(html).toContain('Sessions stay LOCAL');
  });

  it('sin backups → mensaje guía', () => {
    const empty = state();
    empty.backups = { daily: [], event: [] };
    expect(SettingsView.render(empty)).toContain('No automatic backups yet');
  });
});

describe('reducer BACKUPS_SYNCED', () => {
  it('guarda el ring en el estado', () => {
    let s = initialState();
    const rings = { daily: [1], event: [] };
    s = rootReducer(s, /** @type {any} */ ({ type: 'BACKUPS_SYNCED', backups: rings }));
    expect(s.backups).toEqual(rings);
  });
});
