// core/importers/netscape.js — Parser de Bookmarks HTML Netscape (Fase 8.2).
// Line-based y tolerante (Chrome/Firefox exportan variantes del mismo formato):
// sin DOM, sin throw — entrada hostil produce árbol vacío, nunca un crash.
//
// Semántica de conversión:
//   carpeta raíz            → bookmarks sueltos = sesión "Imported bookmarks"
//   carpeta de 1er nivel    → UNA sesión
//   subcarpetas (cualquier profundidad) → grupos; el path profundo se aplana
//   bookmarks propios de cada nivel → ungroupedTabs de su sesión / tabs del grupo

import { MAX_IMPORT_TABS, unescapeHtmlText, secToMs } from './draft.js';

/**
 * @typedef {{ title: string, url: string, savedAt: number, tags: string[] }} Anchor
 * @typedef {{ name: string, anchors: Anchor[], children: FolderNode[] }} FolderNode
 */

const H3_RE = /<DT>\s*<H3\b([^>]*)>([^<]*)<\/H3>/i;
const A_RE = /<DT>\s*<A\b([^>]*)>([^<]*)(?:<\/A>)?/i;
// Atributos estilo Netscape: HREF, ADD_DATE, LAST_MODIFIED, TAGS… (con "_").
const ATTR_RE = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** @returns {FolderNode} */
function emptyFolder(name = '') {
  return { name, anchors: [], children: [] };
}

/**
 * Extrae atributos lowercased de la porción `key="v"` / `key='v'`.
 * @param {string} chunk @returns {Record<string, string>}
 */
function parseAttrs(chunk) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const m of String(chunk).matchAll(ATTR_RE)) {
    out[m[1].toLowerCase()] = m[2] ?? m[3] ?? '';
  }
  return out;
}

/**
 * Parsea el HTML de marcadores a un árbol de carpetas.
 * @param {string} text
 * @returns {{ root: FolderNode, truncated: boolean }}
 */
export function parseNetscapeHtml(text) {
  const root = emptyFolder('root');
  /** @type {FolderNode[]} */
  const stack = [root];
  let pendingName = '';
  let count = 0;
  let truncated = false;
  let seenFirstList = false;

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (/<DL\b/i.test(line)) {
      // Convención del formato: el PRIMER <DL> es el contenedor raíz que
      // envuelve TODO (Chrome/Firefox lo emiten tras el <H1>). No crea nodo:
      // sus hijos cuelgan directamente de root.
      if (!seenFirstList) {
        seenFirstList = true;
        continue;
      }
      const node = emptyFolder(pendingName);
      stack[stack.length - 1].children.push(node);
      stack.push(node);
      pendingName = '';
      continue;
    }
    if (/<\/DL/i.test(line)) {
      if (stack.length > 1) stack.pop();
      continue;
    }

    const h3 = line.match(H3_RE);
    if (h3) {
      pendingName = unescapeHtmlText(h3[2]).trim();
      continue;
    }

    const a = line.match(A_RE);
    if (a && count < MAX_IMPORT_TABS) {
      const attrs = parseAttrs(a[1]);
      const href = (attrs.href ?? '').trim();
      if (href) {
        const title = unescapeHtmlText(a[2]).trim();
        stack[stack.length - 1].anchors.push({
          url: href,
          title,
          savedAt: secToMs(attrs.add_date),
          tags: attrs.tags
            ? attrs.tags
                .split(',')
                .map((t) => t.trim())
                .filter(Boolean)
            : [],
        });
        count++;
      }
      continue;
    }
    if (count >= MAX_IMPORT_TABS && a) truncated = true;
  }
  return { root, truncated };
}

/**
 * Convierte el árbol en drafts de sesión. Pura.
 * @param {FolderNode} root
 * @returns {{ drafts: import('./draft.js').SessionDraft[], truncated: boolean }}
 */
export function netscapeToDrafts(root) {
  /** @type {import('./draft.js').SessionDraft[]} */
  const drafts = [];

  if (root.anchors.length > 0) {
    drafts.push({ name: 'Imported bookmarks', ungroupedTabs: root.anchors });
  }

  for (const child of root.children) {
    /** @type {import('./draft.js').DraftGroup[]} */
    const groups = [];
    collectGroups(child, '', groups);
    const draft = {
      name: child.name || 'Imported session',
      groups,
      ungroupedTabs: child.anchors,
    };
    // Sesión vacía pero con nombre útil (carpetas organizativas): conservar igualmente.
    drafts.push(draft);
  }
  return { drafts, truncated: false };
}

/**
 * Recolecta TODAS las subcarpetas como grupos planos; la profundidad se refleja
 * en el nombre ("Padre / Hijo"). Los anchors de cada carpeta van a SU grupo.
 * @param {FolderNode} node
 * @param {string} prefix
 * @param {import('./draft.js').DraftGroup[]} out
 */
function collectGroups(node, prefix, out) {
  for (const child of node.children) {
    const name = prefix ? `${prefix} / ${child.name || 'Untitled'}` : child.name || 'Untitled';
    out.push({ name, tabs: child.anchors });
    collectGroups(child, name, out);
  }
}
