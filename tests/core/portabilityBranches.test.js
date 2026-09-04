// tests/core/portabilityBranches.test.js — Branches de exporters/importers:
// markdown/bookmarks con shapes completos y vacíos, drafts hostiles,
// sessionBuddy/onetab/urlList/netscape caps y entradas raras.

import { describe, it, expect } from 'vitest';
import { sessionToMarkdown } from '../../core/exporters/markdown.js';
import { sessionsToBookmarksHtml } from '../../core/exporters/bookmarks.js';
import { draftsToPayload, looseMs } from '../../core/importers/draft.js';
import { parseSessionBuddy } from '../../core/importers/sessionBuddy.js';
import { parseOneTab } from '../../core/importers/onetab.js';
import { parseUrlList } from '../../core/importers/urlList.js';
import { parseNetscapeHtml, netscapeToDrafts } from '../../core/importers/netscape.js';
import { detectImportFormat, convertToPayload } from '../../core/importers/index.js';

const tab = (over = {}) => ({
  id: 't',
  url: 'https://x.com/a',
  title: 'A',
  favicon: '',
  note: '',
  tags: [],
  savedAt: 1,
  ...over,
});

describe('markdown exporter (branches)', () => {
  it('sesión completa: grupos con color/tags/nota, tabs con nota, flags', () => {
    const session = {
      id: 's1',
      name: 'Full [session]',
      created: 1,
      updated: 2,
      pinned: true,
      isTemplate: true,
      autoSaved: true,
      stash: false,
      tags: ['work', 'x'],
      metadata: { tabCount: 2, groupCount: 1 },
      groups: [
        {
          id: 'g1',
          name: '',
          color: 'blue',
          tags: ['code'],
          note: 'nota grupo',
          tabs: [{ ...tab(), note: 'nota tab' }],
        },
      ],
      ungroupedTabs: [{ ...tab({ title: '', note: 'nota ungrouped' }) }],
    };
    const md = sessionToMarkdown(/** @type {any} */ (session));
    expect(md).toContain('Full \\[session\\]');
    expect(md).toContain('`blue`');
    expect(md).toContain('Tags: code');
    expect(md).toContain('nota grupo');
    expect(md).toContain('nota tab');
    expect(md).toContain('nota ungrouped');
    expect(md).toContain('auto-saved');
    expect(md).toContain('work, x');
  });

  it('sesión mínima sin grupos: sin secciones de grupo', () => {
    const md = sessionToMarkdown(
      /** @type {any} */ ({
        id: 's2',
        name: 'Solo',
        created: 1,
        updated: 2,
        groups: [],
        ungroupedTabs: [tab()],
      })
    );
    expect(md).toContain('Solo');
    expect(md).not.toContain('## Untitled Group');
  });
});

describe('bookmarks exporter (branches)', () => {
  it('grupos vacíos se saltan; ungrouped va a la raíz de la carpeta; TAGS de sesión', () => {
    const html = sessionsToBookmarksHtml(
      /** @type {any} */ ([
        {
          id: 's1',
          name: 'Con grupos',
          updated: 1_700_000_000_000,
          tags: ['work'],
          groups: [
            { id: 'g', name: 'G1', tabs: [] },
            { id: 'g2', name: 'G2', tabs: [tab()] },
          ],
          ungroupedTabs: [tab({ url: 'https://y.com/b', title: 'B' })],
        },
      ])
    );
    expect(html).toContain('G2');
    expect(html).not.toContain('G1<');
    expect(html).toContain('y.com');
    expect(html).toContain('TAGS');
  });

  it('lista vacía → HTML con DL vacío sin lanzar', () => {
    const html = sessionsToBookmarksHtml(/** @type {any} */ ([]));
    expect(html).toContain('<!DOCTYPE NETSCAPE-Bookmark-file-1>');
  });
});

describe('draftsToPayload / looseMs (branches)', () => {
  it('drafts sin nombre y sin tabs se saltan; vacío → warning', () => {
    const out = draftsToPayload(
      /** @type {any} */ ([
        { name: '', ungroupedTabs: [] },
        { name: 'OK', ungroupedTabs: [tab()] },
      ])
    );
    expect(Object.keys(out.payload.sessions ?? {}).length).toBe(1);
    const empty = draftsToPayload(/** @type {any} */ ([]));
    expect(empty.warnings).toContain('no usable content found');
  });

  it('looseMs: números finitos pasan tal cual; ISO parsea; basura → 0', () => {
    expect(looseMs(1_700_000_000)).toBe(1_700_000_000);
    expect(looseMs(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(looseMs('2024-01-01T00:00:00Z')).toBe(Date.parse('2024-01-01T00:00:00Z'));
    expect(looseMs(0)).toBe(0);
    expect(looseMs(-5)).toBe(0);
    expect(looseMs('no-fecha')).toBe(0);
    expect(looseMs(Number.NaN)).toBe(0);
  });
});

describe('sessionBuddy (branches)', () => {
  it('{sessions:[…]} y array plano; entradas inválidas se saltan', () => {
    const wrapped = parseSessionBuddy(
      JSON.stringify({
        sessions: [
          { name: 'A', tabs: [{ url: 'https://a.com', title: 'A' }] },
          null,
          { name: 'Empty', tabs: [] },
          { name: 'Bad urls', tabs: [{ url: '' }, 'nope'] },
        ],
      })
    );
    expect(wrapped?.drafts.length).toBe(1);
    expect(wrapped?.drafts[0].name).toBe('A');

    const flat = parseSessionBuddy(JSON.stringify([{ name: 'F', tabs: [{ url: 'https://f.com' }] }]));
    expect(flat?.drafts.length).toBe(1);
  });

  it('fechas ISO y ms; basura total → null', () => {
    const withDates = parseSessionBuddy(
      JSON.stringify({
        sessions: [{ name: 'D', created: '2024-01-01T00:00:00Z', tabs: [{ url: 'https://d.com' }] }],
      })
    );
    expect(withDates?.drafts[0].created).toBeTypeOf('number');
    expect(parseSessionBuddy('no json')).toBeNull();
    expect(parseSessionBuddy('{"sessions": 5}')).toBeNull();
  });
});

describe('onetab / urlList / netscape (caps y bordes)', () => {
  it('onetab: bloques; primera línea no-URL es título del bloque', () => {
    const out = parseOneTab('https://a.com | A\n\nbasura sin pipe\nhttps://b.com | B');
    expect(out?.drafts.length).toBe(2);
    expect(out?.drafts[0]?.ungroupedTabs?.length).toBe(1);
    expect(out?.drafts[1]?.name).toBe('basura sin pipe');
    expect(out?.drafts[1]?.ungroupedTabs?.length).toBe(1);
    expect(parseOneTab('')?.drafts).toEqual([]);
  });

  it('urlList: dominios sin esquema → https; comentarios # se saltan', () => {
    const out = parseUrlList('# comentario\nexample.com\nhttps://b.com/x');
    expect(out?.drafts[0]?.ungroupedTabs?.map((/** @type {any} */ t) => t.url)).toEqual([
      'https://example.com',
      'https://b.com/x',
    ]);
  });

  it('netscape: carpetas anidadas se aplanan como "Padre / Hijo"', () => {
    const html = [
      '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
      '<DL><p>',
      '<DT><H3>Padre</H3>',
      '<DL><p>',
      '<DT><H3>Hijo</H3>',
      '<DL><p>',
      '<DT><A HREF="https://deep.com/x">X</A>',
      '</DL><p>',
      '</DL><p>',
      '</DL><p>',
    ].join('\n');
    const tree = parseNetscapeHtml(html);
    expect(tree.root.children.map((c) => c.name)).toEqual(['Padre']);
    const { drafts } = netscapeToDrafts(tree.root);
    const d0 = /** @type {any} */ (drafts[0]);
    expect(drafts.length).toBe(1);
    expect(d0.name).toBe('Padre');
    // subcarpeta de 1er nivel bajo la sesión → grupo con su nombre directo
    expect(d0.groups?.[0]?.name).toBe('Hijo');
    expect(d0.groups?.[0]?.tabs?.[0]?.url).toBe('https://deep.com/x');
  });
});

describe('detectImportFormat / convertToPayload', () => {
  it('detecta por contenido; JSON sin sesiones Buddy → null', () => {
    expect(detectImportFormat('b.html', '<!DOCTYPE NETSCAPE-Bookmark-file-1')).toBe('netscape');
    expect(
      detectImportFormat(
        'x.json',
        JSON.stringify({ sessions: [{ name: 'A', tabs: [{ url: 'https://a.com' }] }] })
      )
    ).toBe('session-buddy');
    expect(detectImportFormat('x.json', '{"sessions":[]}')).toBeNull();
    expect(detectImportFormat('t.txt', 'https://a.com | A\nhttps://b.com | B\nc.com')).toBe('onetab');
  });

  it('convierte onetab a payload; desconocido → null; netscape real → payload', () => {
    expect(convertToPayload('onetab', 'https://a.com | A')?.payload).toBeTruthy();
    expect(convertToPayload(/** @type {any} */ ('desconocido'), 'x')).toBeNull();
    const nested = convertToPayload(
      'netscape',
      [
        '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
        '<DL><p>',
        '<DT><H3>P</H3>',
        '<DL><p>',
        '<DT><A HREF="https://deep.com/x">X</A>',
        '</DL><p>',
        '</DL><p>',
      ].join('\n')
    );
    expect(nested?.payload).toBeTruthy();
  });
});
