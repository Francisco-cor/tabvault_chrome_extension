// tests/e2e/helpers.js — Utilidades compartidas de los specs E2E (Fase 10).
// El registro del SW de MV3 es flaky en Chromium nuevo: polling + relanzamiento
// del contexto (el 2º arranque registra de forma fiable).

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Raíz del repo (3 niveles desde tests/e2e/*.js). */
export const extPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Lanza Chromium con la extensión y devuelve { context, extensionId }.
 * @param {typeof import('@playwright/test').chromium} chromium
 * @param {{ attempts?: number }} [opts]
 */
export async function launchWithExtension(chromium, { attempts = 3 } = {}) {
  /** @param {any} context @param {number} timeoutMs */
  const findSw = async (context, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let sw = context.serviceWorkers()[0];
      if (!sw) {
        try {
          sw = await context.waitForEvent('serviceworker', { timeout: 500 });
        } catch {
          /* reintenta hasta el deadline */
        }
      }
      if (sw) return sw;
      if (Date.now() > deadline) return null;
    }
  };

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
    });
    const sw = await findSw(context, attempt === 1 ? 6_000 : 12_000);
    if (sw) return { context, extensionId: new URL(sw.url()).host };
    await context.close();
  }
  throw new Error('Extension service worker never registered');
}

/**
 * Abre popup/sidepanel/newtab como página navegable.
 * @param {any} context @param {string} extensionId @param {string} pagePath
 */
export async function openExtensionPage(context, extensionId, pagePath) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${pagePath}`);
  await page.waitForLoadState('domcontentloaded');
  return page;
}

/**
 * Siembra sesiones sintéticas en chrome.storage.local (desde el contexto de página).
 * @param {any} page
 * @param {Record<string, unknown>} sessions
 */
export async function seedSessions(page, sessions) {
  await page.evaluate(
    (data) => chrome.storage.local.set({ sessions: data.sessions, trash: data.trash ?? {} }),
    {
      sessions,
    }
  );
}

/**
 * Siembra sesiones + settings base (onboarding fuera: su overlay bloquea los
 * clicks de Playwright por hit-target). Llamar ANTES del reload.
 * @param {any} page
 * @param {Record<string, unknown>} sessions
 * @param {Record<string, unknown>} [extraSettings]
 */
export async function seedVault(page, sessions, extraSettings = {}) {
  await page.evaluate(
    (data) =>
      chrome.storage.local.set({
        sessions: data.sessions,
        trash: {},
        settings: { onboardingDone: true, ...data.extra },
      }),
    { sessions, extra: extraSettings }
  );
}

/**
 * Genera N sesiones × tabsPerSession deterministas (nombres/URLs variados).
 * @param {number} count @param {number} tabsPerSession
 */
export function makeFixtureSessions(count, tabsPerSession) {
  const words = ['github', 'docs', 'mail', 'calendar', 'drive', 'figma', 'jira', 'news', 'repo', 'wiki'];
  /** @type {Record<string, any>} */
  const sessions = {};
  for (let s = 0; s < count; s++) {
    const w1 = words[s % words.length];
    const w2 = words[(s * 7 + 3) % words.length];
    sessions[`s${s}`] = {
      id: `s${s}`,
      name: `${w1} ${w2} — project ${s}`,
      created: 1_700_000_000_000 + s * 1_000,
      updated: 1_700_000_000_000 + s * 60_000,
      groups: [],
      ungroupedTabs: Array.from({ length: tabsPerSession }, (_, t) => ({
        id: `s${s}t${t}`,
        url: `https://${w1}${t}.com/${w2}/${s}/${t}`,
        title: `${w1} ${w2} tab ${t} of project ${s}`,
        favicon: '',
        note: '',
        tags: t === 0 ? [w1] : [],
        savedAt: 1_700_000_000_000 + s * 1_000 + t,
      })),
    };
  }
  return sessions;
}

/** Percentil p95 de una lista de duraciones ms. @param {number[]} xs */
export function p95(xs) {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
}
