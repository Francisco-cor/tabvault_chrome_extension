// tests/core/importers.test.js — Fase 8.2: parsers tolerantes de formatos
// externos (Netscape, OneTab, Session Buddy, lista de URLs) y conversión a
// payload TabVault validado.
import { describe, it, expect } from 'vitest';
import { parseNetscapeHtml, netscapeToDrafts } from '../../core/importers/netscape.js';
import { parseOneTab } from '../../core/importers/onetab.js';
import { parseUrlList } from '../../core/importers/urlList.js';
import { parseSessionBuddy } from '../../core/importers/sessionBuddy.js';
import { detectImportFormat, convertToPayload } from '../../core/importers/index.js';
import { draftsToPayload } from '../../core/importers/draft.js';
import { validateImportPayload } from '../../core/schema.js';

const NETSCAPE_SAMPLE = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><A HREF="https://loose.dev/" ADD_DATE="1700000000">Loose root</A>
    <DT><H3 ADD_DATE="1700000000" LAST_MODIFIED="1700000001">Work</H3>
    <DL><p>
        <DT><A HREF="https://mail.dev/" ADD_DATE="1700000000" TAGS="inbox,daily">Mail</A>
        <DT><H3>Docs</H3>
        <DL><p>
            <DT><A HREF="https://spec.dev/x" ADD_DATE="1700000100">Spec &amp; notes</A>
        </DL><p>
    </DL><p>
</DL><p>`;

describe('parseNetscapeHtml', () => {
  it('árbol: raíz con anchor suelto + carpeta Work con subcarpeta Docs', () => {
    const { root, truncated } = parseNetscapeHtml(NETSCAPE_SAMPLE);
    expect(truncated).toBe(false);
    expect(root.anchors).toHaveLength(1);
    expect(root.anchors[0]).toMatchObject({ url: 'https://loose.dev/', title: 'Loose root' });
    const work = root.children[0];
    expect(work?.name).toBe('Work');
    expect(work?.anchors[0]).toMatchObject({ title: 'Mail' });
    expect(work?.anchors[0]?.tags).toEqual(['inbox', 'daily']);
    expect(work?.anchors[0]?.savedAt).toBe(1_700_000_000_000);
    expect(work?.children[0]).toMatchObject({ name: 'Docs' });
    expect(work?.children[0]?.anchors[0]?.title).toBe('Spec & notes'); // unescape
  });

  it('entrada hostil nunca lanza', () => {
    for (const junk of [
      '',
      '<DL><p>',
      '</DL></DL></DL>',
      '<DT><H3>Unclosed',
      '\x00\x01\x02<DT>',
      NETSCAPE_SAMPLE.slice(0, 40),
    ]) {
      expect(() => parseNetscapeHtml(junk)).not.toThrow();
    }
    const { root } = parseNetscapeHtml('</DL><DT><A HREF="https://x.dev">x</A>');
    expect(root.children).toHaveLength(0); // pop en vacío ignorado
  });
});

describe('netscapeToDrafts → payload validado', () => {
  it('raíz suelta = sesión "Imported bookmarks"; carpetas = sesiones con grupos aplanados', () => {
    const { root } = parseNetscapeHtml(NETSCAPE_SAMPLE);
    const { drafts } = netscapeToDrafts(root);
    expect(drafts.map((d) => d.name)).toEqual(['Imported bookmarks', 'Work']);
    expect(drafts[0]?.ungroupedTabs).toHaveLength(1);
    expect(drafts[1]?.groups?.map((g) => g.name)).toEqual(['Docs']);
    expect(drafts[1].ungroupedTabs).toHaveLength(1);

    const { payload, warnings } = draftsToPayload(drafts);
    expect(warnings).toEqual([]);
    const report = validateImportPayload(payload);
    expect(report.ok).toBe(true);
    const sessions = Object.values(report.value.sessions ?? {});
    const work = sessions.find((s) => s.name === 'Work');
    expect(work?.metadata).toEqual({ groupCount: 1, tabCount: 2 });
  });
});

describe('parseOneTab', () => {
  it('bloques separados por línea en blanco; "url | título"', () => {
    const text = [
      '# OneTab export',
      'https://a.dev | A title',
      'https://b.dev',
      '',
      '(no title)',
      'https://c.dev | C',
    ].join('\n');
    const { drafts, truncated } = parseOneTab(text);
    expect(truncated).toBe(false);
    expect(drafts).toHaveLength(2);
    expect(drafts[0]?.name).toBe('OneTab 1'); // '# OneTab export' se salta como comentario
    expect(drafts[0]?.ungroupedTabs?.[0]).toMatchObject({ url: 'https://a.dev', title: 'A title' });
    expect(drafts[0]?.ungroupedTabs).toHaveLength(2);
    expect(drafts[1]?.name).toBe('(no title)');
  });

  it('sin URLs → drafts vacíos sin lanzar', () => {
    expect(parseOneTab('hola\nmundo').drafts).toHaveLength(0);
  });
});

describe('parseUrlList', () => {
  it('dominios sin esquema reciben https://; comentarios fuera', () => {
    const { drafts } = parseUrlList('# comment\nexample.com\nhttps://a.dev/x\ngitlab.io\nnope no-space ok');
    expect(drafts[0]?.ungroupedTabs?.map((t) => t.url)).toEqual([
      'https://example.com',
      'https://a.dev/x',
      'https://gitlab.io',
    ]);
  });
});

describe('parseSessionBuddy', () => {
  it('formato {sessions:[…]} con fecha ISO y tabs crudas', () => {
    const res = parseSessionBuddy(
      JSON.stringify({
        sessions: [
          { name: 'Morning', created: '2026-01-05T08:00:00Z', tabs: [{ url: 'https://m.dev', title: 'M' }] },
        ],
      })
    );
    expect(res?.drafts[0]).toMatchObject({ name: 'Morning', created: Date.UTC(2026, 0, 5, 8) });
    expect(res?.drafts[0]?.ungroupedTabs).toHaveLength(1);
  });

  it('también acepta array plano; null para JSON ajeno', () => {
    const arr = parseSessionBuddy(JSON.stringify([{ title: 'T', tabs: [{ url: 'https://t.dev' }] }]));
    expect(arr?.drafts[0]?.name).toBe('T');
    expect(parseSessionBuddy('{"foo":1}')).toBeNull();
    expect(parseSessionBuddy('not json')).toBeNull();
  });
});

describe('detectImportFormat', () => {
  it('clasifica por contenido', () => {
    expect(detectImportFormat('bookmarks.html', NETSCAPE_SAMPLE)).toBe('netscape');
    expect(detectImportFormat('', '<DT><A HREF="https://x">x</A>')).toBe('netscape');
    expect(detectImportFormat('one.txt', 'https://a.dev | x\nhttps://b.dev')).toBe('onetab');
    expect(detectImportFormat('list.txt', 'https://a.dev\nhttps://b.dev\nhttps://c.dev')).toBe('url-list');
    const buddy = JSON.stringify({ sessions: [{ tabs: [{ url: 'https://x.dev' }] }] });
    expect(detectImportFormat('sb.json', buddy)).toBe('session-buddy');
    expect(detectImportFormat('', '{"_tabvault":true}')).toBeNull(); // TabVault va por otro camino
    expect(detectImportFormat('', 'random words only')).toBeNull();
  });

  it('html sin marcadores Netscape → null (evita falsos positivos)', () => {
    expect(detectImportFormat('page.html', '<html><body>hi</body></html>')).toBeNull();
  });
});

describe('convertToPayload end-to-end', () => {
  it('netscape hostil: URLs javascript:/data: descartadas con aviso', () => {
    const text = `<DL><p>
      <DT><A HREF="javascript:alert(1)">evil</A>
      <DT><A HREF="data:text/html,<script>alert(1)</script>">evil2</A>
      <DT><A HREF="https://good.dev">ok</A>
    </DL><p>`;
    const out = convertToPayload('netscape', text);
    expect(out).not.toBeNull();
    expect(out?.warnings.some((w) => /inválidas o inseguras/.test(w))).toBe(true);
    const report = validateImportPayload(out?.payload);
    expect(report.ok).toBe(true);
    const all = Object.values(report.value.sessions ?? {}).flatMap((s) => s.ungroupedTabs.map((t) => t.url));
    expect(all).toEqual(['https://good.dev/']);
  });

  it('formato desconocido → null', () => {
    expect(convertToPayload('url-list', 'no urls here')).toBeNull();
  });
});
