// tests/core/importPlan.test.js — Fase 8.1: planificación del merge inteligente.
import { describe, it, expect } from 'vitest';
import { planImport } from '../../core/importPlan.js';
import { jaccardSimilarity, urlsOfSession } from '../../core/domain.js';
import { makeSession, makeTab } from '../fixtures/sessions.js';

// Los mapas de sesiones usan la clave como id (invariante del repo): el helper
// exige id explícito para no depender de UUIDs aleatorios del fixture.
const urls = (/** @type {string} */ id, /** @type {string[]} */ list) =>
  makeSession({ id, ungroupedTabs: list.map((u) => makeTab({ id: u, url: u })) });

describe('jaccardSimilarity / urlsOfSession', () => {
  it('0 con conjuntos disjuntos, 1 con idénticos', () => {
    const a = urlsOfSession(urls('a', ['https://a.dev/1', 'https://a.dev/2']));
    const b = urlsOfSession(urls('b', ['https://a.dev/2', 'https://b.dev/1']));
    expect(jaccardSimilarity(a, a)).toBe(1);
    expect(jaccardSimilarity(a, b)).toBeCloseTo(1 / 3);
    expect(jaccardSimilarity(a, new Set())).toBe(0);
  });
});

describe('planImport', () => {
  it('colisión de id vs contenido similar vs fresca', () => {
    const existing = {
      keep: urls('keep', ['https://x.dev/1', 'https://x.dev/2']),
      twin: urls('twin', ['https://t.dev/1', 'https://t.dev/2', 'https://t.dev/3', 'https://t.dev/4']),
    };
    const incoming = {
      keep: urls('keep', ['https://new.dev/9']), // mismo id "keep" → colisión
      // exactamente 80% Jaccard con twin (4 comunes / unión de 5)
      twinCopy: urls('twinCopy', [
        'https://t.dev/1',
        'https://t.dev/2',
        'https://t.dev/3',
        'https://t.dev/4',
        'https://t.dev/5',
      ]),
      fresh: urls('fresh', ['https://fresh.dev/1']),
    };
    incoming.twinCopy.name = 'Twin copy';
    const plan = planImport(incoming, existing, 80);
    expect(plan.idCollisions).toEqual([{ incomingId: 'keep' }]);
    expect(plan.fresh).toEqual(['twinCopy', 'fresh']); // similar se evalúa entre frescas
    expect(plan.similar).toHaveLength(1);
    expect(plan.similar[0]).toMatchObject({
      incomingId: 'twinCopy',
      existingId: 'twin',
      pct: 80,
    });
    expect(plan.similar[0]?.incomingName).toBe('Twin copy');
  });

  it('umbral desde settings (pct) respeta límites', () => {
    const existing = { a: urls('a', ['https://a.dev/1']) };
    const incoming = { b: urls('b', ['https://a.dev/1', 'https://z.dev/9']) }; // Jaccard 1/2 = 50%
    expect(planImport(incoming, existing, 50).similar).toHaveLength(1);
    expect(planImport(incoming, existing, 60).similar).toHaveLength(0);
    expect(planImport(incoming, existing, 999).similar).toHaveLength(0); // clamp ≤0.99
  });

  it('vacíos → plan vacío sin lanzar', () => {
    expect(planImport({}, {}, 80)).toEqual({ fresh: [], idCollisions: [], similar: [] });
  });
});
