// tests/background/capture.test.js — Capturador compartido (fix C5).
// Los grupos nativos se reconstruyen desde tab.groupId en TODOS los flujos.
import { describe, it, expect, beforeEach } from 'vitest';
import { installChromeMock } from '../mocks/chrome.js';
import { buildSessionFromTabs, captureWindow, captureAllWindows } from '../../background/handlers/capture.js';

describe('buildSessionFromTabs', () => {
  it('asigna tabs a sus grupos nativos preservando el orden', async () => {
    const built = await buildSessionFromTabs(
      [
        { url: 'https://a.com/1', title: 'A1', groupId: 7 },
        { url: 'https://u.com/1', title: 'U1' },
        { url: 'https://a.com/2', title: 'A2', groupId: 7 },
        { url: 'https://b.com/1', title: 'B1', groupId: 9 },
      ],
      [
        { id: 7, title: 'Work', color: 'blue' },
        { id: 9, title: 'Docs', color: 'green' },
      ],
      { fetchFavicons: false }
    );

    expect(built.groups).toHaveLength(2);
    expect(built.groups[0].name).toBe('Work');
    expect(built.groups[0].color).toBe('blue');
    expect(built.groups[0].tabs.map((t) => t.title)).toEqual(['A1', 'A2']);
    expect(built.groups[1].name).toBe('Docs');
    expect(built.ungroupedTabs.map((t) => t.title)).toEqual(['U1']);
    expect(built.metadata).toEqual({ groupCount: 2, tabCount: 4 });
    // los ids de grupo son UUID nuevos, no el nativo
    expect(built.groups[0].id).not.toBe(7);
  });

  it('descarta URLs no capturables individualmente (sin perder el resto)', async () => {
    const built = await buildSessionFromTabs(
      [
        { url: 'chrome://settings', title: 'settings' },
        { url: 'https://keep.com', title: 'keep' },
        { url: 'javascript:alert(1)', title: 'evil' },
        { url: 'edge://version', title: 'edge' },
      ],
      [],
      { fetchFavicons: false }
    );
    // URLs crudas (la normalización a u.href ocurre en repo.saveSession → schema)
    expect(built.ungroupedTabs.map((t) => t.url)).toEqual(['https://keep.com']);
    expect(built.validCount).toBe(1);
  });

  it('captura flags pinned/active cuando están presentes', async () => {
    const built = await buildSessionFromTabs(
      [
        { url: 'https://p.com', title: 'P', pinned: true },
        { url: 'https://q.com', title: 'Q', active: true },
      ],
      [],
      { fetchFavicons: false }
    );
    expect(built.ungroupedTabs[0].pinned).toBe(true);
    expect(built.ungroupedTabs[1].active).toBe(true);
  });

  it('los grupos que quedan vacíos tras filtrar se eliminan', async () => {
    const built = await buildSessionFromTabs(
      [{ url: 'chrome://x', title: 'x', groupId: 3 }],
      [{ id: 3, title: 'Ghost', color: 'red' }],
      { fetchFavicons: false }
    );
    expect(built.groups).toHaveLength(0);
  });
});

describe('captureWindow / captureAllWindows (integración con chrome mock)', () => {
  /** @type {ReturnType<typeof installChromeMock>} */
  let h;
  beforeEach(() => {
    h = installChromeMock();
    h.reset();
  });

  it('captura una ventana viva con grupos y metadata correctos', async () => {
    const winId = h.seedWindow({}, [
      { url: 'https://mail.google.com/inbox', title: 'Gmail' },
      { url: 'https://github.com/prs', title: 'GitHub', groupId: 55 },
      { url: 'https://docs.google.com/doc', title: 'Docs', groupId: 55 },
      { url: 'chrome://newtab', title: 'New Tab' },
    ]);
    h.seedGroup(winId, 55, 'Trabajo', 'purple');

    const captured = await captureWindow(winId);
    expect(captured.incognito).toBe(false);
    expect(captured.metadata.groupCount).toBe(1);
    expect(captured.metadata.tabCount).toBe(3);
    const group = captured.groups[0];
    expect(group.name).toBe('Trabajo');
    expect(group.tabs).toHaveLength(2);
    expect(captured.ungroupedTabs[0].title).toBe('Gmail');
  });

  it('excluye ventanas incógnito por defecto y las incluye con flag', async () => {
    h.seedWindow({}, [{ url: 'https://normal.com', title: 'N' }]);
    h.seedWindow({ incognito: true }, [{ url: 'https://private.com', title: 'P' }]);

    const without = await captureAllWindows({ fetchFavicons: false });
    expect(without).toHaveLength(1);
    expect(without[0].ungroupedTabs[0].url).toBe('https://normal.com');

    const withInc = await captureAllWindows({ includeIncognito: true, fetchFavicons: false });
    expect(withInc).toHaveLength(2);
  });

  it('omite ventanas sin ninguna tab válida', async () => {
    h.seedWindow({}, [{ url: 'chrome://version', title: 'v' }]);
    const captured = await captureAllWindows({ fetchFavicons: false });
    expect(captured).toHaveLength(0);
  });
});
