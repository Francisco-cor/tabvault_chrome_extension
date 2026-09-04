// tests/core/exportersFase8.test.js — Fase 8.2: Markdown enriquecido (M11) y
// Bookmarks Netscape.
import { describe, it, expect } from 'vitest';
import { sessionToMarkdown } from '../../core/exporters/markdown.js';
import { sessionsToBookmarksHtml } from '../../core/exporters/bookmarks.js';
import { makeSession, makeGroup, makeTab } from '../fixtures/sessions.js';

const rich = () =>
  makeSession({
    id: 's1',
    name: 'Work [research]',
    created: Date.UTC(2026, 0, 1, 10),
    updated: Date.UTC(2026, 0, 2, 10),
    tags: ['work', 'q1'],
    isTemplate: true,
    pinned: true,
    groups: [
      makeGroup({
        name: 'Docs',
        color: 'blue',
        tags: ['reading'],
        note: 'group note line\nsecond line',
        tabs: [
          makeTab({
            title: 'Spec [v2]',
            url: 'https://spec.dev/x',
            note: 'tab note',
            tags: ['api'],
            pinned: true,
          }),
          makeTab({ title: 'Plain', url: 'https://plain.dev' }),
        ],
      }),
    ],
    ungroupedTabs: [makeTab({ id: 'u1', title: 'Loose', url: 'https://loose.dev', note: 'loose note' })],
  });

describe('sessionToMarkdown (enriquecido, M11 completo)', () => {
  const md = sessionToMarkdown(rich());

  it('encabezado con metadatos y flags', () => {
    expect(md).toContain('# Work \\[research\\]');
    expect(md).toMatch(/Created: .+/);
    expect(md).toContain('3 tabs · 1 groups');
    expect(md).toContain('*Flags: pinned, template*');
  });

  it('tags de sesión, grupo y tab presentes', () => {
    expect(md).toContain('*Tags: work, q1*');
    expect(md).toContain('Tags: reading');
    expect(md).toContain('*Tags: api*');
  });

  it('notas de grupo Y de tab (incluida ungrouped)', () => {
    expect(md).toContain('> group note line');
    expect(md).toContain('> second line');
    expect(md).toContain('> tab note');
    expect(md).toContain('> loose note'); // M11: ungrouped nunca más omitido
  });

  it('links con título escapado y marcador pinned', () => {
    expect(md).toContain('- [Spec \\[v2\\]](https://spec.dev/x) *(pinned)*');
    expect(md).toContain('- [Plain](https://plain.dev)');
    expect(md).toContain('## Ungrouped');
  });

  it('pura y determinista', () => {
    expect(sessionToMarkdown(rich())).toBe(md);
  });
});

describe('sessionsToBookmarksHtml (Netscape)', () => {
  const html = sessionsToBookmarksHtml([rich(), makeSession({ id: 'empty', name: 'Empty' })]);

  it('cabecera Netscape válida para Chrome/Firefox', () => {
    expect(html).toContain('<!DOCTYPE NETSCAPE-Bookmark-file-1>');
    expect(html).toContain('charset=UTF-8');
    expect(html).toContain('<DL><p>');
    expect(html.trim().endsWith('</DL><p>')).toBe(true);
  });

  it('carpetas por sesión y por grupo con fechas en segundos', () => {
    // El export estampa LAST_MODIFIED/ADD_DATE con session.updated.
    const secs = String(Math.floor(Date.UTC(2026, 0, 2, 10) / 1000));
    // La sesión lleva TAGS de sesión en el H3 (inyectadas antes de ADD_DATE).
    expect(html).toContain(`TAGS="work,q1" ADD_DATE="${secs}" LAST_MODIFIED="${secs}">Work [research]</H3>`);
    expect(html).toContain('>Docs</H3>');
    expect(html).not.toContain('>Empty</H3>'); // sesión vacía sin contenido se omite
  });

  it('bookmarks con HREF seguro, TAGS attr y escape HTML', () => {
    expect(html).toContain('<A HREF="https://spec.dev/x"');
    expect(html).toContain('TAGS="api"');
    expect(html).toContain('>Spec [v2]<');
    // TAGS de sesión inyectadas en el H3
    expect(html).toMatch(/<H3 TAGS="work,q1"/);
  });

  it('URLs inseguras jamás se exportan', () => {
    const hostile = makeSession({
      id: 'h',
      name: 'Hostile',
      ungroupedTabs: [
        makeTab({ id: 'x1', url: 'javascript:alert(1)' }),
        makeTab({ id: 'x2', url: 'https://ok.dev' }),
      ],
    });
    const out = sessionsToBookmarksHtml([hostile]);
    expect(out).not.toContain('javascript:');
    expect(out).toContain('https://ok.dev');
  });
});
