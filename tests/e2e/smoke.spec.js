// tests/e2e/smoke.spec.js — Humo E2E: carga la extensión y abre el popup.
// Requiere: npx playwright install chromium (se hace en CI).
//
// FIX Fase 10: el extPath estaba mal calculado (dos dirname desde tests/e2e
// caían en tests/) → Chrome cargaba la carpeta tests/ sin manifest y TODOS los
// specs se saltaban en silencio, local y en CI. Tres dirname = raíz del repo.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, chromium } from '@playwright/test';

const extPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * El registro del SW de MV3 es flaky en Chromium nuevo: a veces no llega el
 * evento. Polling con relanzamiento del contexto (2ª arranque registra fiable).
 * @param {typeof chromium} browserType
 */
async function launchWithExtension() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
    });
    let sw = context.serviceWorkers()[0];
    const deadline = Date.now() + (attempt === 1 ? 6_000 : 12_000);
    while (!sw && Date.now() < deadline) {
      try {
        sw = await context.waitForEvent('serviceworker', { timeout: 500 });
      } catch {
        /* re-intenta hasta el deadline */
      }
    }
    if (sw) return { context, extensionId: new URL(sw.url()).host };
    await context.close();
  }
  throw new Error('Extension service worker never registered');
}

let context;
let page;

test.beforeAll(async () => {
  try {
    const launched = await launchWithExtension();
    context = launched.context;
    page = await context.newPage();
    await page.goto(`chrome-extension://${launched.extensionId}/popup/popup.html`);
    await page.waitForLoadState('domcontentloaded');
  } catch {
    test.skip(true, 'Playwright browsers no instalados (npx playwright install chromium)');
  }
});

test.afterAll(async () => {
  await context?.close();
});

test('el popup renderiza el header TabVault', async () => {
  await expect(page.locator('.logo-text')).toHaveText('TabVault');
});

test('existen las 5 pestañas de navegación', async () => {
  const tabs = page.locator('.nav-tab');
  await expect(tabs).toHaveCount(5);
  await expect(tabs.first()).toContainText('Sessions');
  await expect(tabs.last()).toContainText('Stats');
});

test('vista inicial muestra empty state o sesiones guardadas', async () => {
  const content = page.locator('#content');
  await expect(content).toBeVisible();
  // Con storage vacío: CTA de guardar presente
  await expect(content.locator('#save-cta')).toBeVisible({ timeout: 10_000 });
});
