// tests/core/backups.test.js — Fase 8.3: helpers puros del ring-buffer.
import { describe, it, expect } from 'vitest';
import {
  stripFavicons,
  buildBackupEntry,
  pushBackup,
  findBackup,
  hasVaultData,
  shouldRemindExport,
  BACKUP_CAPS,
} from '../../core/backups.js';
import { makeSession, makeGroup, makeTab } from '../fixtures/sessions.js';

describe('stripFavicons', () => {
  it('vacía favicon en sesiones/grupos/tabs/versiones sin tocar lo demás', () => {
    const input = {
      sessions: {
        s1: {
          ...makeSession({
            groups: [makeGroup({ tabs: [makeTab({ favicon: 'data:image/png;base64,AAA' })] })],
            ungroupedTabs: [makeTab({ favicon: 'data:image/png;base64,BBB' })],
          }),
        },
      },
      versions: { s1: [{ snapshot: { ungroupedTabs: [makeTab({ favicon: 'X' })] }, savedAt: 1 }] },
      settings: { theme: 'dark' },
    };
    const out = stripFavicons(input);
    expect(out.sessions.s1.groups[0].tabs[0].favicon).toBe('');
    expect(out.sessions.s1.ungroupedTabs[0].favicon).toBe('');
    expect(out.versions.s1[0].snapshot.ungroupedTabs[0].favicon).toBe('');
    // intacto lo no-favicon
    expect(out.sessions.s1.groups[0].tabs[0].url).toContain('example.com');
    expect(out.settings.theme).toBe('dark');
    // pureza: original sin cambios
    expect(input.sessions.s1.ungroupedTabs[0].favicon).toBe('data:image/png;base64,BBB');
  });
});

describe('buildBackupEntry', () => {
  it('contadores y tamaño coherentes; data sin favicons', () => {
    const state = {
      sessions: {
        a: makeSession({
          id: 'a',
          name: 'A',
          groups: [makeGroup({ tabs: [makeTab(), makeTab()] })],
        }),
        b: makeSession({ id: 'b', name: 'B', ungroupedTabs: [makeTab()] }),
      },
      trash: { t: { ...makeSession({ id: 't' }), deletedAt: 123 } },
    };
    const entry = buildBackupEntry('daily', 5_000, state);
    expect(entry.label).toBe('daily');
    expect(entry.ts).toBe(5_000);
    expect(entry.counts).toEqual({ sessions: 2, tabs: 3, trash: 1 });
    expect(entry.size).toBe(JSON.stringify(entry.data).length);
    expect(JSON.stringify(entry.data)).not.toContain('data:image');
  });
});

describe('pushBackup / findBackup (anillos)', () => {
  it('daily cap 7, event cap 3 — un pre-import nunca expulse diarios', () => {
    let rings = pushBackup({ daily: [], event: [] }, buildBackupEntry('daily', 1, {}));
    rings = pushBackup(rings, buildBackupEntry('pre-import', 2, {}));
    for (let i = 10; i <= 40; i++) {
      rings = pushBackup(rings, buildBackupEntry(i % 4 === 0 ? 'pre-import' : 'daily', i, {}));
    }
    expect(rings.daily.length).toBe(BACKUP_CAPS.daily);
    expect(rings.event.length).toBe(BACKUP_CAPS.event);
    expect(rings.daily.some((e) => e.ts === 1) || rings.event.length > 0).toBe(true);
  });

  it('findBackup busca en ambos anillos', () => {
    const rings = pushBackup(
      pushBackup({ daily: [], event: [] }, buildBackupEntry('daily', 100, {})),
      buildBackupEntry('pre-restore', 200, {})
    );
    expect(findBackup(rings, 100)?.label).toBe('daily');
    expect(findBackup(rings, 200)?.label).toBe('pre-restore');
    expect(findBackup(rings, 999)).toBeNull();
  });
});

describe('hasVaultData / shouldRemindExport', () => {
  it('vault vacío → sin snapshot diario', () => {
    expect(hasVaultData({})).toBe(false);
    expect(hasVaultData({ sessions: {}, trash: {} })).toBe(false);
    expect(hasVaultData({ sessions: { a: makeSession() } })).toBe(true);
    expect(hasVaultData({ trash: { a: makeSession() } })).toBe(true);
  });

  it('14 días sin export ni dismiss → recuerda', () => {
    const now = Date.UTC(2026, 7, 22);
    const day = 86_400_000;
    expect(shouldRemindExport(0, 0, now)).toBe(true); // nunca exportado
    expect(shouldRemindExport(now - 13 * day, 0, now)).toBe(false);
    expect(shouldRemindExport(now - 14 * day, 0, now)).toBe(true);
    // dismiss reciente silencia aunque el export sea viejo
    expect(shouldRemindExport(0, now - 13 * day, now)).toBe(false);
    expect(shouldRemindExport(0, now - 15 * day, now)).toBe(true);
  });

  it('intervalo inyectable', () => {
    const now = Date.UTC(2026, 0, 1);
    expect(shouldRemindExport(now - 8 * 86_400_000, 0, now, { days: 7 })).toBe(true);
  });
});
