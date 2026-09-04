// core/searchIndex.js — Motor de búsqueda (Fase 7.1). Reemplaza a searchSessions
// de shared/utils.js (muere junto con su warning de complejidad).
//
// Arquitectura:
//  1. ÍNDICE INVERTIDO en memoria: token → Set<sessionId>, construido al cargar y
//     mantenido INCREMENTALMENTE (sync() hace diff por firma `updated`; toda mutación
//     del repo pasa por updateSession que siempre la bumpa).
//  2. OPERADORES parseados antes de buscar: "frase exacta", domain:x, tag:x,
//     in:name|url|notes <término> (alcance al término inmediato) + alias name:/url:/notes:.
//  3. CANDIDATOS por postings (token exacto + prefijos sobre vocabulario ordenado);
//     el fallback difuso lineal SOLO corre cuando el índice no produjo nada.
//  4. RANKING combinado: score textual (escala heredada 100/85/72/60/42/30) +
//     frescura + pins + frecuencia de apertura. Reloj inyectable → determinista.
//
// Sin chrome.*, sin I/O: 100% testeable. El shape de resultado es compatible con
// la vista ({...session, _score, _matchingTabs}) para no romper consumidores.

/** @typedef {import('../shared/types.js').Session} Session */
/** @typedef {import('../shared/types.js').SessionMap} SessionMap */
/** @typedef {import('../shared/types.js').TabItem} TabItem */

// ─── Tokenización ─────────────────────────────────────────────────────────────

/**
 * Tokens lowercase para el índice. Unicode-aware: 'árbol' → ['árbol'].
 * @param {unknown} text
 * @returns {string[]}
 */
export function tokenize(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

// ─── Scoring textual ──────────────────────────────────────────────────────────

const SCORES = Object.freeze({
  EQUAL: 100,
  STARTS_WITH: 85,
  WORD_START: 72,
  CONTAINS: 60,
  FUZZY_CONTIGUOUS: 42,
  FUZZY: 30,
});

/** @param {string} c */
function isSeparator(c) {
  return !/[a-z0-9]/.test(c);
}

/**
 * ¿El needle empieza en algún límite de palabra del haystack?
 * @param {string} h haystack ya en lowercase @param {string} n needle ya en lowercase
 */
function wordStartHit(h, n) {
  let i = h.indexOf(n);
  while (i !== -1) {
    if (i === 0 || isSeparator(h[i - 1])) return true;
    i = h.indexOf(n, i + 1);
  }
  return false;
}

/**
 * Fuzzy carácter-a-carácter. Bonus si ≥70 % de la needle cae en UNA sola
 * racha contigua (match "casi seguido", p.ej. wzrd→wizard): sube de 30 → 42,
 * siempre por debajo de contains=60.
 * @param {string} n @param {string} h
 */
function scatteredScore(n, h) {
  let hi = 0;
  let run = 0;
  let bestRun = 0;
  for (let ni = 0; ni < n.length; ni++) {
    const found = h.indexOf(n[ni], hi);
    if (found === -1) return 0;
    run = found === hi ? run + 1 : 1;
    if (run > bestRun) bestRun = run;
    hi = found + 1;
  }
  const tightRatio = bestRun / n.length;
  return tightRatio >= 0.7 ? SCORES.FUZZY_CONTIGUOUS : SCORES.FUZZY;
}

/**
 * Score textual mejorado (Fase 7.1): igual semántica que el fuzzy heredado con
 * dos escalones nuevos — inicio de palabra (72) y racha contigua (42).
 * @param {string} needle @param {string} haystack @returns {number} 0–100
 */
export function fuzzyScore(needle, haystack) {
  if (!needle || !haystack) return 0;
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();
  if (h === n) return SCORES.EQUAL;
  if (h.startsWith(n)) return SCORES.STARTS_WITH;
  if (wordStartHit(h, n)) return SCORES.WORD_START;
  if (h.includes(n)) return SCORES.CONTAINS;
  return scatteredScore(n, h);
}

// ─── Parseo de operadores ─────────────────────────────────────────────────────

/**
 * Query parseada. Los operadores FILTRAN (AND); los términos libres PUNTÚAN.
 *
 * @typedef {Object} ParsedQuery
 * @property {string[]} phrases   de "…" (lowercase, substring obligatoria)
 * @property {string[]} domains   de domain:host
 * @property {string[]} tags      de tag:x
 * @property {{ name: string[], url: string[], notes: string[] }} inFields
 * @property {string[]} terms     tokens libres que puntúan
 */

/** @returns {ParsedQuery} */
function emptyQuery() {
  return { phrases: [], domains: [], tags: [], inFields: { name: [], url: [], notes: [] }, terms: [] };
}

const IN_FIELDS = new Set(['name', 'url', 'notes']);
const FIELD_OPS = /** @type {const} */ ([
  ['name:', 'name'],
  ['url:', 'url'],
  ['note:', 'notes'],
  ['notes:', 'notes'],
]);

/**
 * Clasifica un token como directiva o término libre.
 * @param {string} low token ya en lowercase
 * @returns {{ kind:'domain'|'tag'|'fieldName'|'pending'|'term',
 *             field?: 'name'|'url'|'notes', value: string }}
 */
function classifyToken(low) {
  /** @param {string} prefix */
  const op = (prefix) => low.slice(prefix.length);
  if (low.startsWith('domain:')) return { kind: 'domain', value: nonEmpty(op('domain:'), low) };
  if (low.startsWith('tag:')) return { kind: 'tag', value: nonEmpty(op('tag:'), low) };
  for (const [prefix, field] of FIELD_OPS) {
    if (!low.startsWith(prefix)) continue;
    const v = op(prefix);
    // Prefijo de operador a secas ("name:") no es búsqueda útil → término libre.
    return v
      ? { kind: 'fieldName', field: /** @type {'name'|'url'|'notes'} */ (field), value: v }
      : { kind: 'term', value: low };
  }
  if (low.startsWith('in:') && IN_FIELDS.has(op('in:'))) {
    return { kind: 'pending', field: /** @type {'name'|'url'|'notes'} */ (op('in:')), value: '' };
  }
  return { kind: 'term', value: low };
}

/** Valor de operador vacío cae a término literal. @param {string} v @param {string} fallback */
function nonEmpty(v, fallback) {
  return v || fallback;
}

/**
 * Parser tolerante: lo que no sea operador conocido es término libre.
 * `in:<campo>` consume SOLO el siguiente token suelto.
 * @param {unknown} raw
 * @returns {ParsedQuery}
 */
export function parseQuery(raw) {
  const q = emptyQuery();
  const re = /"([^"]*)"|(\S+)/g;
  /** @type {RegExpExecArray|null} */
  let m;
  /** @type {'name'|'url'|'notes'|null} */
  let pendingField = null;
  while ((m = re.exec(String(raw ?? '')))) {
    if (m[1] !== undefined) {
      const phrase = m[1].trim().toLowerCase();
      if (phrase) q.phrases.push(phrase);
      pendingField = null;
      continue;
    }
    const low = m[2].toLowerCase();
    if (pendingField && !low.includes(':')) {
      q.inFields[pendingField].push(low);
      pendingField = null;
      continue;
    }
    pendingField = null;
    const tok = classifyToken(low);
    switch (tok.kind) {
      case 'domain':
        q.domains.push(tok.value);
        break;
      case 'tag':
        q.tags.push(tok.value);
        break;
      case 'fieldName':
        q.inFields[tok.field ?? 'name'].push(tok.value);
        break;
      case 'pending':
        pendingField = tok.field ?? null;
        break;
      default:
        q.terms.push(tok.value);
    }
  }
  return q;
}

/** ¿La query tiene ALGÚN criterio? Si no, la búsqueda devuelve recientes.
 * @param {ParsedQuery} parsed */
export function isEmptyQuery(parsed) {
  const f = parsed.inFields;
  return (
    parsed.phrases.length === 0 &&
    parsed.domains.length === 0 &&
    parsed.tags.length === 0 &&
    parsed.terms.length === 0 &&
    f.name.length === 0 &&
    f.url.length === 0 &&
    f.notes.length === 0
  );
}

// ─── Documentos del índice ────────────────────────────────────────────────────

/**
 * @typedef {Object} TabDoc
 * @property {string} id
 * @property {TabItem} raw          referencia a la tab ORIGINAL (para render)
 * @property {string} titleL
 * @property {string} urlL
 * @property {string} noteL
 * @property {string[]} tagsL
 * @property {string} groupName
 */

/**
 * @typedef {Object} Doc
 * @property {string} sid
 * @property {string} sig            firma de contenido (diff incremental)
 * @property {boolean} pinned
 * @property {number} lastOpened
 * @property {number} openCount
 * @property {number} updated
 * @property {string} nameText
 * @property {string} allText        todo el contenido concatenado (phrases/fuzzy)
 * @property {{ name: string, url: string, notes: string }} fieldTexts
 * @property {Set<string>} tagSet    todas las tags en lowercase
 * @property {Set<string>} domainSet hostnames sin www
 * @property {TabDoc[]} tabs
 */

/** @param {string} url @returns {string} hostname sin www o '' */
function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Firma barata de contenido para el diff incremental. `updated` basta en
 * producción (toda mutación pasa por updateSession, que lo bumpa), pero
 * nombre + ids de primera/última tab hacen la firma resistente también a
 * objetos con timestamps idénticos (fixtures, imports manuales).
 * @param {Session} s
 */
function signatureOf(s) {
  /** @type {import('../shared/types.js').TabItem[]} */
  const flat = [...(s.groups ?? []).flatMap((g) => g.tabs ?? []), ...(s.ungroupedTabs ?? [])];
  const n = flat.length;
  return `${s.updated}|${s.name}|${n}|${n ? flat[0].id : ''}|${n ? flat[n - 1].id : ''}`;
}

/**
 * Construye el documento indexable de una sesión. Pura.
 * @param {string} sid @param {Session} s @returns {Doc}
 */
export function buildDoc(sid, s) {
  /** @type {TabDoc[]} */
  const tabs = [];
  /** @type {string[]} */
  const parts = [s.name];
  /** @type {string[]} */
  const urls = [];
  /** @type {string[]} */
  const notes = [];
  /** @type {Set<string>} */
  const tagSet = new Set();
  /** @type {Set<string>} */
  const domainSet = new Set();

  for (const t of s.tags ?? []) {
    const low = t.toLowerCase();
    tagSet.add(low);
    parts.push(low); // las tags de sesión también son tokens buscables
  }

  /** @param {any} g nombre del grupo o '' */
  const pushGroupMeta = (g) => {
    if (!g) return '';
    if (g.name) parts.push(g.name.toLowerCase());
    if (g.note) notes.push(g.note.toLowerCase());
    for (const t of g.tags ?? []) {
      const low = t.toLowerCase();
      tagSet.add(low);
      parts.push(low); // ídem para tags de grupo
    }
    return g.name ?? '';
  };

  for (const g of s.groups ?? []) {
    const gName = pushGroupMeta(g);
    for (const t of g.tabs ?? []) collect(t, gName);
  }
  for (const t of s.ungroupedTabs ?? []) collect(t, 'Ungrouped');

  /** @param {TabItem} t @param {string} gName */
  function collect(t, gName) {
    const titleL = String(t.title ?? '').toLowerCase();
    const urlL = String(t.url ?? '').toLowerCase();
    const noteL = String(t.note ?? '').toLowerCase();
    const tagsL = (t.tags ?? []).map((x) => x.toLowerCase());
    tabs.push({ id: t.id, raw: t, titleL, urlL, noteL, tagsL, groupName: gName });
    parts.push(titleL, noteL, ...tagsL);
    if (noteL) notes.push(noteL); // fieldTexts.notes para el operador in:notes
    if (urlL) {
      parts.push(urlL);
      urls.push(urlL);
      const h = hostOf(t.url ?? '');
      if (h) domainSet.add(h);
    }
    for (const x of tagsL) tagSet.add(x);
  }

  return {
    sid,
    sig: signatureOf(s),
    pinned: !!s.pinned,
    lastOpened: s.lastOpened ?? 0,
    openCount: s.openCount ?? 0,
    updated: s.updated,
    nameText: s.name.toLowerCase(),
    allText: parts.join(' ').toLowerCase(),
    fieldTexts: { name: s.name.toLowerCase(), url: urls.join(' '), notes: notes.join(' ') },
    tagSet,
    domainSet,
    tabs,
  };
}

// ─── Índice ───────────────────────────────────────────────────────────────────

const PREFIX_SCAN_LIMIT = 500;

/**
 * Índice invertido + buscador. Instanciable puro; `searchVault()` expone un
 * singleton auto-sincronizado para las vistas.
 * @returns {{
 *   upsert: (sid: string, session: Session) => void,
 *   remove: (sid: string) => void,
 *   sync: (sessions: SessionMap) => void,
 *   size: () => number,
 *   search: (query: unknown, opts?: { now?: number, limit?: number }) => any[]
 * }}
 */
export function createSearchIndex() {
  /** @type {Map<string, Doc>} */
  const docs = new Map();
  /** @type {Map<string, Set<string>>} token → sids */
  const postings = new Map();
  /** @type {string[]|null} vocabulario ordenado (cache invalidada al mutar) */
  let vocab = null;

  /** @param {string} sid @param {Doc} doc */
  function indexDoc(sid, doc) {
    for (const tok of tokenize(doc.allText)) addPosting(tok, sid);
  }

  /** @param {string} sid @param {Doc|null} oldDoc */
  function unindexDoc(sid, oldDoc) {
    if (!oldDoc) return;
    for (const tok of tokenize(oldDoc.allText)) {
      const set = postings.get(tok);
      if (!set) continue;
      set.delete(sid);
      if (set.size === 0) postings.delete(tok);
    }
  }

  /** @param {string} tok @param {string} sid */
  function addPosting(tok, sid) {
    let set = postings.get(tok);
    if (!set) {
      set = new Set();
      postings.set(tok, set);
    }
    set.add(sid);
  }

  /**
   * Upsert incremental. Firma = updated (+tabCount defensivo): cualquier
   * escritura del repo pasa por updateSession que bumpa updated.
   * @param {string} sid @param {Session} session
   */
  function upsert(sid, session) {
    remove(sid);
    const doc = buildDoc(sid, session);
    docs.set(sid, doc);
    indexDoc(sid, doc);
    vocab = null;
  }

  /** @param {string} sid */
  function remove(sid) {
    unindexDoc(sid, docs.get(sid) ?? null);
    docs.delete(sid);
    vocab = null;
  }

  /**
   * Diff incremental contra el mapa vivo: upsert de cambiadas/nuevas,
   * remove de desaparecidas. Barato: O(sesiones) comparaciones de firmas.
   * @param {SessionMap} sessions
   */
  function sync(sessions) {
    /** @type {Set<string>} */
    const seen = new Set();
    for (const [id, s] of Object.entries(sessions ?? {})) {
      seen.add(id);
      const doc = docs.get(id);
      if (doc && doc.sig === signatureOf(s) && doc.tabs.length === (s.metadata?.tabCount ?? 0)) continue;
      upsert(id, s);
    }
    for (const id of [...docs.keys()]) {
      if (!seen.has(id)) remove(id);
    }
  }

  /**
   * Candidatos por término libre: union(exacto, prefijo); si el índice no da
   * nada, fallback difuso lineal (comportamiento heredado preservado).
   * @param {string[]} terms @returns {Set<string>|null} null = sin restricción
   */
  function candidatesFor(terms) {
    if (terms.length === 0) return null;
    /** @type {Set<string>|null} */
    let acc = null;
    for (const term of terms) {
      const hits = termHits(term);
      if (hits.size === 0) {
        // Fallback difuso: solo escanea todo si este término no matcheó índice.
        for (const [sid, doc] of docs) {
          if (fuzzyScore(term, doc.nameText) > 0) hits.add(sid);
          else if (doc.tabs.some((t) => tabTermScore(term, t) > 0)) hits.add(sid);
        }
      }
      if (acc === null) acc = hits;
      else {
        for (const sid of [...acc]) if (!hits.has(sid)) acc.delete(sid);
      }
      if (acc.size === 0) return acc;
    }
    return acc;
  }

  /** @param {string} term @returns {Set<string>} */
  function termHits(term) {
    /** @type {Set<string>} */
    const out = new Set();
    const exact = postings.get(term);
    if (exact) for (const sid of exact) out.add(sid);
    if (!vocab) vocab = [...postings.keys()].sort();
    let scanned = 0;
    for (const tok of vocab) {
      if (!tok.startsWith(term) || tok === term) continue;
      const set = postings.get(tok);
      if (set) for (const sid of set) out.add(sid);
      if (++scanned >= PREFIX_SCAN_LIMIT) break;
    }
    return out;
  }

  /**
   * Búsqueda principal. Sin query → sesiones ordenadas por updated desc
   * (mismo contrato que el motor viejo).
   * @param {unknown} query
   * @param {{ now?: number, limit?: number }} [opts]
   * @returns {(Session & {_score?: number, _matchingTabs?: any[]})[]}
   */
  function search(query, opts = {}) {
    const now = opts.now ?? Date.now();
    const limit = opts.limit ?? 60;
    const parsed = parseQuery(query);
    if (isEmptyQuery(parsed)) {
      /** @type {Session[]} */
      const recents = [];
      for (const d of [...docs.values()].sort((a, b) => b.updated - a.updated)) {
        const raw = rawOf(d.sid);
        if (raw) recents.push(raw);
      }
      return recents;
    }

    const candidates = candidatesFor(parsed.terms) ?? new Set(docs.keys());
    /** @type {{ sid: string, score: number, matchingTabs: any[] }[]} */
    const scored = [];
    for (const sid of candidates) {
      const doc = docs.get(sid);
      if (!doc) continue;
      if (!passesFilters(doc, parsed)) continue;
      const { score, matchingTabs } = scoreDoc(doc, parsed, now);
      if (score <= 0) continue;
      scored.push({ sid, score, matchingTabs });
    }

    scored.sort(
      (a, b) => b.score - a.score || (docs.get(b.sid)?.updated ?? 0) - (docs.get(a.sid)?.updated ?? 0)
    );

    /** @type {(Session & {_score: number, _matchingTabs: any[]})[]} */
    const out = [];
    for (const { sid, score, matchingTabs } of scored.slice(0, limit)) {
      const raw = rawOf(sid);
      if (raw) out.push({ ...raw, _score: score, _matchingTabs: matchingTabs });
    }
    return out;
  }

  /** Mapa fuente sincronizado (para devolver la Session original, no copias). */
  const sourceMap = new Map();

  /** @param {string} sid @returns {Session|null} */
  function rawOf(sid) {
    return /** @type {Session|undefined} */ (sourceMap.get(sid)) ?? null;
  }

  return {
    upsert(sid, session) {
      upsert(sid, session);
      sourceMap.set(sid, session);
    },
    remove(sid) {
      remove(sid);
      sourceMap.delete(sid);
    },
    sync(sessions) {
      sync(sessions);
      sourceMap.clear();
      // NOTA: sourceMap es un Map → Object.assign NO sirve (definiría
      // propiedades planas, nunca entradas). Copiar con set() explícito.
      for (const [id, s] of Object.entries(sessions ?? {})) sourceMap.set(id, s);
    },
    size: () => docs.size,
    search,
  };
}

/**
 * Filtros operador (AND): todos deben pasar.
 * @param {Doc} doc @param {ParsedQuery} q
 */
export function passesFilters(doc, q) {
  for (const d of q.domains) {
    let hit = false;
    for (const host of doc.domainSet) {
      if (host.includes(d) || d.includes(host)) {
        hit = true;
        break;
      }
    }
    if (!hit) return false;
  }
  for (const t of q.tags) {
    if (!doc.tagSet.has(t)) return false;
  }
  for (const p of q.phrases) {
    if (!doc.allText.includes(p)) return false;
  }
  for (const v of q.inFields.name) {
    if (!doc.fieldTexts.name.includes(v)) return false;
  }
  for (const v of q.inFields.url) {
    if (!doc.fieldTexts.url.includes(v)) return false;
  }
  for (const v of q.inFields.notes) {
    if (!doc.fieldTexts.notes.includes(v)) return false;
  }
  return true;
}

/** @param {string} term @param {TabDoc} t @returns {number} mejor score del campo */
function tabTermScore(term, t) {
  return Math.max(
    fuzzyScore(term, t.titleL),
    fuzzyScore(term, t.urlL),
    fuzzyScore(term, t.noteL),
    ...(t.tagsL.length ? t.tagsL.map((g) => fuzzyScore(term, g)) : [0])
  );
}

/** Mejor score de un término libre en cualquier campo del doc. @param {Doc} doc @param {string} term */
function termBestInDoc(doc, term) {
  let best = fuzzyScore(term, doc.nameText);
  for (const tg of doc.tagSet) best = Math.max(best, fuzzyScore(term, tg));
  for (const t of doc.tabs) best = Math.max(best, tabTermScore(term, t));
  return best;
}

/** Score de una tab contra términos+frases (para _matchingTabs). @param {TabDoc} t @param {ParsedQuery} q */
function tabHitScore(t, q) {
  let ts = 0;
  for (const term of q.terms) ts += tabTermScore(term, t);
  for (const p of q.phrases) {
    if (t.titleL.includes(p) || t.urlL.includes(p) || t.noteL.includes(p)) ts += SCORES.CONTAINS;
  }
  return ts;
}

// ─── Ranking ──────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/**
 * Bonus de frescura sobre `updated` (reloj inyectable).
 * @param {number} updated @param {number} now
 */
export function freshnessBonus(updated, now) {
  const age = now - updated;
  if (age <= DAY_MS) return 8;
  if (age <= 7 * DAY_MS) return 4;
  return 0;
}

/**
 * Bonus por uso: frecuencia de apertura (cap 5) + apertura reciente 48h.
 * @param {Doc} doc @param {number} now
 */
export function usageBonus(doc, now) {
  const freq = Math.min(doc.openCount, 5) * 1.5;
  const recent = doc.lastOpened > 0 && now - doc.lastOpened <= 2 * DAY_MS ? 5 : 0;
  return freq + recent;
}

/**
 * Score total de un doc contra la query parseada + sus tabs matcheadas.
 * @param {Doc} doc @param {ParsedQuery} q @param {number} now
 * @returns {{ score: number, matchingTabs: any[] }}
 */
export function scoreDoc(doc, q, now) {
  let base = 0;
  // Términos libres: el MEJOR campo define el score del término (heredado);
  // multi-término suma (AND ya garantizado por candidatos).
  for (const term of q.terms) {
    const best = termBestInDoc(doc, term);
    if (best <= 0) return { score: 0, matchingTabs: [] }; // defensa extra
    base += best;
  }
  // Operadores sin términos libres: presencia pura pero rankeable por boosts.
  if (base === 0) base = 25;

  /** @type {any[]} */
  const matchingTabs = [];
  if (q.terms.length > 0 || q.phrases.length > 0) {
    for (const t of doc.tabs) {
      const ts = tabHitScore(t, q);
      if (ts > 0) {
        // Shape plano heredado: la vista consume tab.* directamente.
        matchingTabs.push({ ...t.raw, _score: ts, _groupName: t.groupName });
      }
    }
    matchingTabs.sort((a, b) => b._score - a._score);
  }

  const total = base + freshnessBonus(doc.updated, now) + (doc.pinned ? 6 : 0) + usageBonus(doc, now);
  return { score: Math.round(total), matchingTabs: matchingTabs.slice(0, 20) };
}

// ─── Singleton auto-sincronizado (para vistas) ────────────────────────────────

let globalIndex = /** @type {ReturnType<typeof createSearchIndex>|null} */ (null);

/**
 * Punto de entrada de la UI: mantiene el índice global en sync con el mapa vivo
 * (diff barato por firmas) y delega la búsqueda. Llámese por tecla/keystroke.
 * @param {SessionMap} sessions
 * @param {unknown} query
 * @param {{ now?: number, limit?: number }} [opts]
 */
export function searchVault(sessions, query, opts = {}) {
  globalIndex ??= createSearchIndex();
  globalIndex.sync(sessions);
  return globalIndex.search(query, opts);
}

/** Solo tests: resetea el singleton. */
export function resetSearchVault() {
  globalIndex = null;
}
