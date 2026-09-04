// core/importPlan.js — Merge inteligente de imports (Fase 8.1). Puro.
//
// Antes de escribir NADA se calcula un plan:
//   - fresh        sesiones entrantes nuevas
//   - idCollisions entrantes que comparten id con una existente → el usuario
//                  elige "update" (reemplaza contenido) o "keep-both" (id nuevo)
//   - similar      entrantes ≥ umbral Jaccard con una existente → checkbox para
//                  saltarlas en vez de duplicar el vault
// Nunca hay pisada silenciosa: toda colisión es visible y decidida en UI.

import { jaccardSimilarity, urlsOfSession } from './domain.js';

/** @typedef {import('../shared/types.js').Session} Session */

/**
 * @typedef {Object} ImportPlan
 * @property {string[]} fresh
 * @property {{ incomingId: string }[]} idCollisions
 * @property {{ incomingId: string, incomingName: string, existingId: string, existingName: string, pct: number }[]} similar
 */

/**
 * @param {Record<string, Session>} incoming mapa validado del archivo
 * @param {Record<string, Session>} existing estado actual del vault
 * @param {number} thresholdPct 50–95 (settings.dupThreshold)
 * @returns {ImportPlan}
 */
export function planImport(incoming, existing, thresholdPct = 80) {
  const threshold = Math.min(0.99, Math.max(0.1, thresholdPct / 100));
  /** @type {ImportPlan['similar']} */
  const similar = [];
  /** @type {string[]} */
  const fresh = [];
  /** @type {ImportPlan['idCollisions']} */
  const collisions = [];

  for (const [id, session] of Object.entries(incoming ?? {})) {
    if (existing[id]) {
      collisions.push({ incomingId: id });
      continue;
    }
    fresh.push(id);

    // Mejor candidata por contenido entre las EXISTENTES.
    const incomingUrls = urlsOfSession(session);
    if (incomingUrls.size === 0) continue;
    let best = null;
    let bestScore = 0;
    for (const candidate of Object.values(existing)) {
      const score = jaccardSimilarity(incomingUrls, urlsOfSession(candidate));
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    if (best && bestScore >= threshold) {
      similar.push({
        incomingId: id,
        incomingName: session.name,
        existingId: best.id,
        existingName: best.name,
        pct: Math.round(bestScore * 100),
      });
    }
  }
  return { fresh, idCollisions: collisions, similar };
}
