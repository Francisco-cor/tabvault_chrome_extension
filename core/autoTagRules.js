// core/autoTagRules.js — Reglas "SI url contiene X ENTONCES tag Y" (Fase 9.5).
// Puras, sin I/O. Se ejecutan en el capturador compartido (buildSessionFromTabs).

/** @typedef {{ id: string, pattern: string, tag: string }} AutoTagRule */

/**
 * Normaliza una regla. Devuelve null si pattern/tag vacíos o > límites.
 * @param {unknown} raw
 * @returns {AutoTagRule|null}
 */
export function normalizeRule(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const r = /** @type {Record<string, unknown>} */ (raw);
  const id = typeof r.id === 'string' ? r.id : '';
  if (!id) return null;
  const pattern = String(r.pattern ?? '')
    .trim()
    .toLowerCase();
  const tag = String(r.tag ?? '')
    .trim()
    .slice(0, 40);
  if (!pattern || pattern.length > 120) return null;
  if (!tag) return null;
  return { id, pattern, tag };
}

/**
 * Totales seguros: cap 50 reglas, normaliza y deduplica por patrón+tag.
 * @param {unknown} raw
 * @returns {AutoTagRule[]}
 */
export function normalizeRules(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {AutoTagRule[]} */
  const out = [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const item of raw) {
    const norm = normalizeRule(item);
    if (!norm) continue;
    const key = `${norm.pattern}|${norm.tag}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(norm);
    if (out.length >= 50) break;
  }
  return out;
}

/**
 * Aplica reglas a una URL: devuelve tags nuevas a añadir (sin duplicar).
 * Match case-insensitive "contains" sobre la URL cruda.
 * @param {string} url
 * @param {AutoTagRule[]} rules
 * @param {Set<string>} [existing] tags ya presentes (lowercase) para dedup
 * @returns {string[]} tags a añadir
 */
export function tagsForUrl(url, rules, existing = new Set()) {
  if (!url || !rules?.length) return [];
  const low = String(url).toLowerCase();
  /** @type {string[]} */
  const out = [];
  for (const r of rules) {
    if (!low.includes(r.pattern)) continue;
    if (existing.has(r.tag.toLowerCase())) continue;
    if (out.some((t) => t.toLowerCase() === r.tag.toLowerCase())) continue;
    out.push(r.tag);
  }
  return out;
}

/**
 * Aplica reglas a una lista de tabs (muta copia ya clonada si se pasa).
 * Cada tab recibe sus tags + los de las reglas que matchean su URL.
 * @param {import('../shared/types.js').TabItem[]} tabs
 * @param {AutoTagRule[]} rules
 * @returns {number} nº de tags añadidas en total
 */
export function applyRulesToTabs(tabs, rules) {
  if (!rules?.length || !tabs?.length) return 0;
  let added = 0;
  for (const t of tabs) {
    const existing = new Set((t.tags ?? []).map((x) => String(x).toLowerCase()));
    const extra = tagsForUrl(t.url ?? '', rules, existing);
    if (extra.length) {
      t.tags = [...(t.tags ?? []), ...extra].slice(0, 24);
      added += extra.length;
    }
  }
  return added;
}

/**
 * Export/import JSON de reglas (redondo sin pérdida).
 * @param {AutoTagRule[]} rules
 * @returns {string}
 */
export function exportRules(rules) {
  return JSON.stringify(rules, null, 2);
}

/**
 * Importa JSON de reglas (tolerante, normaliza).
 * @param {string} json
 * @returns {{ rules: AutoTagRule[], errors: string[] }}
 */
export function importRules(json) {
  try {
    const data = JSON.parse(json);
    if (!Array.isArray(data)) return { rules: [], errors: ['Not an array'] };
    const rules = normalizeRules(data);
    const errors = [];
    if (rules.length < data.length)
      errors.push(`${data.length - rules.length} rule(s) ignored (invalid/duplicate)`);
    return { rules, errors };
  } catch {
    return { rules: [], errors: ['Invalid JSON'] };
  }
}
