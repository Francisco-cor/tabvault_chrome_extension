// tests/core/fuzz.test.js — CRITERIO DE ACEPTACIÓN Fase 8: 1.000 payloads
// aleatorios/maliciosos contra el importador.
//
// Garantías verificadas por iteración:
//  1. importAll NUNCA corrompe storage (post-import sigue funcionando el repo).
//  2. NUNCA hay prototype pollution (Object.prototype intacto).
//  3. NINGUNA URL almacenada es insegura (javascript:/data: — payload XSS incluido).
// PRNG con semilla fija: fallo reproducible siempre.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Repository } from '../../core/repository.js';
import { installChromeMock } from '../mocks/chrome.js';
import { validateImportPayload, safeUrl } from '../../core/schema.js';
import { makeSession } from '../fixtures/sessions.js';

/** @type {ReturnType<typeof installChromeMock>} */
let mock;
/** @type {Repository} */
let repo;

beforeEach(() => {
  mock = installChromeMock();
  repo = new Repository({ writable: true });
});
afterEach(() => mock.unmock());

// ─── PRNG determinista (mulberry32) ──────────────────────────────────────────
/**
 * @param {number} seed
 * @returns {() => number}
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ATTACK_URLS = [
  'javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  ' javascript:alert(1)',
  'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
  'data:image/svg+xml,<svg onload=alert(1)>',
  'vbscript:msgbox(1)',
  'file:///etc/passwd',
  '//evil.dev/x',
];
const ATTACK_STRINGS = [
  '<script>alert(1)</script>',
  '"><img src=x onerror=alert(1)>',
  '</textarea><script>alert(1)</script>',
  '__proto__',
  'constructor',
  '${jndi:dns://x}',
];

const pick = (/** @type {() => number} */ rnd, /** @type {any[]} */ arr) =>
  arr[Math.floor(rnd() * arr.length)];

/**
 * Genera un "documento" JSON arbitrario mezclando basura estructural y ataques.
 * @param {() => number} rnd
 */
function chaosDocument(rnd) {
  /** @type {Record<string, any>} */
  const doc = {};
  if (rnd() < 0.9) doc._tabvault = true; // a veces sin marca → debe ser rechazado

  const sessionFactory = () => {
    /** @type {Record<string, any>} */
    const s = {};
    if (rnd() < 0.8) s.name = rnd() < 0.3 ? pick(rnd, ATTACK_STRINGS) : `S${Math.floor(rnd() * 100)}`;
    if (rnd() < 0.9) s.created = rnd() < 0.1 ? 1e21 : Math.floor(rnd() * 2e12);
    if (rnd() < 0.7)
      s.groups = Array.from({ length: Math.floor(rnd() * 3) }, () => ({
        name: pick(rnd, ['G', '', null, pick(rnd, ATTACK_STRINGS)]),
        color: pick(rnd, ['blue', 'nope', 42]),
        tabs: Array.from({ length: Math.floor(rnd() * 4) }, () => ({
          url: rnd() < 0.35 ? pick(rnd, ATTACK_URLS) : `https://ok${Math.floor(rnd() * 50)}.dev/p`,
          title: pick(rnd, ATTACK_STRINGS.concat(['T'])),
          favicon: rnd() < 0.2 ? 'javascript:f()' : 'data:image/png;base64,iVBORw0KGgo=',
          note: rnd() < 0.2 ? pick(rnd, ATTACK_STRINGS) : '',
          tags: rnd() < 0.3 ? [pick(rnd, ATTACK_STRINGS), 'ok-tag'] : [],
          savedAt: rnd() < 0.1 ? -5 : Date.now(),
        })),
      }));
    if (rnd() < 0.7)
      s.ungroupedTabs = Array.from({ length: Math.floor(rnd() * 4) }, () => ({
        url: rnd() < 0.35 ? pick(rnd, ATTACK_URLS) : `https://fine${Math.floor(rnd() * 50)}.io`,
      }));
    if (rnd() < 0.15) s.metadata = { groupCount: -99, tabCount: { evil: true } };
    if (rnd() < 0.1) s.pinned = 'yes';
    if (rnd() < 0.1) s.order = 1e21;
    return s;
  };

  if (rnd() < 0.85) {
    doc.sessions = {};
    const n = Math.floor(rnd() * 4);
    for (let i = 0; i < n; i++) {
      // claves hostiles incluidas explícitamente
      const key =
        rnd() < 0.12
          ? pick(rnd, ['__proto__', 'constructor', 'prototype'])
          : `s${i}-${Math.floor(rnd() * 1e6)}`;
      doc.sessions[key] = sessionFactory();
    }
  }
  if (rnd() < 0.25)
    doc.trash = { [pick(rnd, ['__proto__', 't1'])]: sessionFactory(), plain: sessionFactory() };
  if (rnd() < 0.2) doc.versions = { v1: [{ snapshot: sessionFactory(), savedAt: Date.now() }, 'junk'] };
  if (rnd() < 0.2) doc.settings = { theme: pick(rnd, ['dark', 'hacker']), dupThreshold: 1e21 };
  return doc;
}

/**
 * Inyecta una clave raíz "__proto__" REAL en el texto JSON (JSON.parse la
 * crea como propiedad propia; el importador jamás debe propagarla).
 * @param {string} json @param {() => number} rnd
 */
function withRootProto(json, rnd) {
  return rnd() < 0.3 ? json.replace('{', '{"__proto__":{"polluted":1},') : json;
}

describe('Fuzzing del importador: 1.000 documentos hostiles', () => {
  it('nunca corrompe storage ni contamina prototipos; cero URLs inseguras almacenadas', async () => {
    const rnd = mulberry32(20260822);
    const protoKeysBefore = Object.getOwnPropertyNames(Object.prototype).join(',');

    let rejected = 0;
    let accepted = 0;

    for (let i = 0; i < 1000; i++) {
      const doc = chaosDocument(rnd);
      const json = withRootProto(JSON.stringify(doc), rnd);

      try {
        await repo.importAll(json, { mode: rnd() < 0.5 ? 'merge' : 'replace' });
        accepted++;
      } catch {
        rejected++; // rechazo limpio también es un resultado válido
      }

      // 1) storage usable tras cada intento
      const probe = makeProbe();
      await repo.saveSession(probe);
      const readBack = await repo.getSession(probe.id);
      expect(readBack?.name).toBe('probe');

      // 2) Object.prototype intacto
      expect(Object.getOwnPropertyNames(Object.prototype).join(',')).toBe(protoKeysBefore);
      expect(/** @type {any} */ ({}).polluted).toBeUndefined();

      // 3) toda URL persistida pasa safeUrl (idempotente ⇒ ya era segura)
      const sessions = (await mock.dumpLocal()).sessions ?? {};
      for (const s of Object.values(sessions)) {
        for (const url of allUrls(s)) {
          expect(safeUrl(url)).toBe(url);
        }
        // y ningún favicon no-imagen/http se coló
        for (const fav of allFavicons(s)) {
          expect(fav).toMatch(/^($|data:image\/|https?:\/\/)/);
        }
      }
    }
    // sanidad de la propia fuzzing-suite: ambos caminos ocurrieron
    expect(rejected).toBeGreaterThan(0);
    expect(accepted).toBeGreaterThan(0);
  }, 30_000);

  it('validateImportPayload directo: claves peligrosas reportadas y descartadas', () => {
    // JSON.parse crea "__proto__" como propiedad PROPIA (el literal JS no lo haría):
    const rawSessions = JSON.stringify({
      good: { id: 'good', name: 'Good', ungroupedTabs: [{ url: 'https://g.dev' }] },
    }).replace('{', '{"__proto__":{"id":"pwned","name":"pwned"},"constructor":{"name":"x"},');
    const doc = { _tabvault: true, sessions: JSON.parse(rawSessions) };
    const report = validateImportPayload(doc);
    expect(report.ok).toBe(true);
    expect(report.errors.some((e) => e.includes('__proto__'))).toBe(true);
    expect(report.errors.some((e) => e.includes('constructor'))).toBe(true);
    expect(Object.keys(report.value.sessions ?? {})).toEqual(['good']);
  });
});

// ─── helpers ────────────────────────────────────────────────────────────────
/** Sesión probe única por llamada. */
let probeSeq = 0;
function makeProbe() {
  return makeSession({ id: `probe-${++probeSeq}`, name: 'probe' });
}
/** @param {any} s @returns {string[]} */
function allUrls(s) {
  return [
    ...(s.groups ?? []).flatMap((/** @type {any} */ g) =>
      (g.tabs ?? []).map((/** @type {any} */ t) => t.url)
    ),
    ...(s.ungroupedTabs ?? []).map((/** @type {any} */ t) => t.url),
  ];
}
/** @param {any} s @returns {string[]} */
function allFavicons(s) {
  return [
    ...(s.groups ?? []).flatMap((/** @type {any} */ g) =>
      (g.tabs ?? []).map((/** @type {any} */ t) => t.favicon ?? '')
    ),
    ...(s.ungroupedTabs ?? []).map((/** @type {any} */ t) => t.favicon ?? ''),
  ];
}
