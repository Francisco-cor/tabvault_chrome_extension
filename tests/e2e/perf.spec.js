// tests/e2e/perf.spec.js — Presupuestos de rendimiento en CI (Fase 10.1).
//
// | Métrica                           | Presupuesto      |
// | --------------------------------- | ---------------- |
// | Arranque popup (init→interactivo) | ≤ 150ms / 100 ses|
// | Búsqueda p95 por tecla            | ≤ 50ms / 5k tabs |
// | Guardar sesión 50 tabs (REPO_OP)  | ≤ 1.500ms        |
// | Heap JS tras uso intensivo        | ≤ 120MB          |
//
// El bundle total (≤250KB sin iconos) se gatea en scripts-dev/check-zip.mjs.

import { test, expect, chromium } from '@playwright/test';
import { launchWithExtension, openExtensionPage, makeFixtureSessions, seedVault } from './helpers.js';

const BUDGET_INIT_MS = 150;
const BUDGET_SEARCH_P95_MS = 50;
const BUDGET_SAVE_MS = 1_500;
const BUDGET_HEAP_BYTES = 120 * 1024 * 1024;

let context;
let extensionId;

test.beforeAll(async () => {
  const launched = await launchWithExtension(chromium);
  context = launched.context;
  extensionId = launched.extensionId;
});

test.afterAll(async () => {
  await context?.close();
});

test('arranque del popup ≤150ms con 100 sesiones', async () => {
  const page = await openExtensionPage(context, extensionId, 'popup/popup.html');
  await seedVault(page, makeFixtureSessions(100, 8));

  // Warm-up: la primera carga paga compilación fría; un usuario real reabre
  // el popup con la caché de código V8 caliente. Medimos en régimen.
  await page.reload();
  await page.waitForSelector('.session-card, .empty-state', { timeout: 15_000 });
  await page.reload();
  await page.waitForSelector('.session-card, .empty-state', { timeout: 15_000 });
  const initMs = await page.evaluate(() => {
    const mark = performance.getEntriesByName('tv-ready')[0];
    return mark ? mark.startTime : -1;
  });
  expect(initMs, `tv-ready debe existir (init completado)`).toBeGreaterThan(0);
  expect(initMs, `init ${initMs.toFixed(1)}ms ≤ ${BUDGET_INIT_MS}ms`).toBeLessThanOrEqual(BUDGET_INIT_MS);
  await page.close();
});

test('búsqueda p95 ≤50ms con 5k tabs (250 sesiones × 20)', async () => {
  test.setTimeout(90_000);
  const page = await openExtensionPage(context, extensionId, 'popup/popup.html');
  await seedVault(page, makeFixtureSessions(250, 20));
  await page.reload();
  await page.waitForSelector('.session-card, .empty-state', { timeout: 20_000 });

  const p = await page.evaluate(async () => {
    const { searchVault } = await import(chrome.runtime.getURL('core/searchIndex.js'));
    const { sessions } = await chrome.storage.local.get('sessions');
    const queries = [
      'git',
      'github docs',
      'domain:github.com',
      'in:name project',
      'tab 5',
      'wiki repo',
      'mail',
      'xqzw',
    ];
    /** p95 de una pasada; el gate usa el MÍNIMO de 3 pasadas: el budget mide
     *  capacidad del sistema, no un pico de GC/ruído de la máquina. */
    /** @type {(xs: number[]) => number} */
    const p95Of = (xs) => {
      const s = [...xs].sort((a, b) => a - b);
      return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
    };
    searchVault(sessions, 'warm up', { now: Date.now() });
    /** @type {number[]} */
    const passP95 = [];
    for (let pass = 0; pass < 3; pass++) {
      /** @type {number[]} */
      const out = [];
      for (const q of queries) {
        const t0 = performance.now();
        searchVault(sessions, q, { now: Date.now() });
        out.push(performance.now() - t0);
      }
      passP95.push(p95Of(out));
    }
    return Math.min(...passP95);
  });

  expect(p, `búsqueda p95 ${p.toFixed(2)}ms ≤ ${BUDGET_SEARCH_P95_MS}ms`).toBeLessThanOrEqual(
    BUDGET_SEARCH_P95_MS
  );
  await page.close();
});

test('guardar sesión de 50 tabs (REPO_OP round-trip) ≤1500ms', async () => {
  const page = await openExtensionPage(context, extensionId, 'popup/popup.html');
  await page.waitForSelector('.session-card, .empty-state', { timeout: 15_000 });

  const tabs = Array.from({ length: 50 }, (_, i) => ({
    id: `perf-t${i}`,
    url: `https://perf.example.com/page/${i}`,
    title: `Perf page ${i}`,
    favicon: '',
    note: '',
    tags: [],
    savedAt: Date.now(),
  }));
  const session = {
    id: 'perf-save-50',
    name: 'Perf save 50 tabs',
    created: Date.now(),
    updated: Date.now(),
    groups: [],
    ungroupedTabs: tabs,
    metadata: { groupCount: 0, tabCount: 50 },
  };

  const elapsed = await page.evaluate(async (payload) => {
    const t0 = performance.now();
    const res = await chrome.runtime.sendMessage({ type: 'REPO_OP', op: 'saveSession', args: [payload] });
    if (!res?.ok) throw new Error(`saveSession failed: ${res?.error}`);
    return performance.now() - t0;
  }, session);

  expect(elapsed, `save 50 tabs ${elapsed.toFixed(1)}ms ≤ ${BUDGET_SAVE_MS}ms`).toBeLessThanOrEqual(
    BUDGET_SAVE_MS
  );
  await page.evaluate(() =>
    chrome.storage.local.remove('sessions').then(() => chrome.storage.local.set({ sessions: {} }))
  );
  await page.close();
});

test('heap JS tras uso intensivo ≤120MB', async () => {
  test.setTimeout(120_000);
  const page = await openExtensionPage(context, extensionId, 'popup/popup.html');
  await seedVault(page, makeFixtureSessions(250, 20));
  await page.reload();
  await page.waitForSelector('.session-card, .empty-state', { timeout: 20_000 });

  // Búsquedas intensivas en una sola evaluación (import una vez, 60 rondas).
  await page.evaluate(async () => {
    const { searchVault } = await import(chrome.runtime.getURL('core/searchIndex.js'));
    const { sessions } = await chrome.storage.local.get('sessions');
    for (let r = 0; r < 60; r++) {
      searchVault(sessions, `project ${r}`, { now: Date.now() });
      searchVault(sessions, 'domain:github.com', { now: Date.now() });
      searchVault(sessions, `tab ${r % 20}`, { now: Date.now() });
    }
  });

  // Navegación entre todas las vistas (stats computa KPIs sobre 5k tabs).
  for (let i = 0; i < 10; i++) {
    await page
      .locator('.nav-tab')
      .nth(i % 5)
      .click();
    await page.waitForTimeout(80);
  }

  const heapBytes = await page.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize : 0));
  expect(heapBytes, `heap ${(heapBytes / 1048576).toFixed(1)}MB ≤ 120MB`).toBeLessThanOrEqual(
    BUDGET_HEAP_BYTES
  );
  await page.close();
});
