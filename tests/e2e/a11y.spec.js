// tests/e2e/a11y.spec.js — Auditoría axe-core de las vistas (Fase 5.2).
// Gate de CI: 0 violaciones serious/critical en cada vista escaneada, en ambas
// superficies (popup y side panel). Requiere `npx playwright install chromium`.

import { test, expect, chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { launchWithExtension, openExtensionPage } from './helpers.js';

/** Sesión sembrada para poder auditar también DetailView. */
function seedSession(id) {
  return {
    id,
    name: 'Axe seed session',
    created: Date.now(),
    updated: Date.now(),
    pinned: false,
    autoSaved: false,
    groups: [
      {
        id: `${id}-g1`,
        name: 'Seed group',
        color: 'blue',
        note: '',
        tags: ['seed'],
        tabs: [{ id: `${id}-t1`, url: 'https://example.com/', title: 'Example', note: '', tags: [] }],
      },
    ],
    ungroupedTabs: [],
    metadata: { groupCount: 1, tabCount: 1 },
  };
}

let context;
let extensionId = '';

/**
 * @param {string} relPath ruta relativa dentro de la extensión
 */
async function openExtPage(relPath) {
  return openExtensionPage(context, extensionId, relPath);
}

/** Escanea la página actual y exige cero violaciones serious/critical.
 * @param {import('@playwright/test').Page} page @param {string} label
 */
async function expectNoSeriousViolations(page, label) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = results.violations.filter(
    (/** @type {any} */ v) => v.impact === 'serious' || v.impact === 'critical'
  );
  if (serious.length > 0) {
    console.error(`[axe] ${label}:`, JSON.stringify(serious, null, 2));
  }
  expect(serious, `${label}: sin violaciones serious/critical`).toEqual([]);
}

test.beforeAll(async () => {
  try {
    const launched = await launchWithExtension(chromium);
    context = launched.context;
    extensionId = launched.extensionId;

    // Sembrar una sesión para habilitar DetailView (+ onboarding fuera:
    // su overlay bloquea hover/clicks de Playwright por hit-target).
    const page = await openExtPage('popup/popup.html');
    await page.evaluate(
      (s) =>
        chrome.storage.local.set({
          sessions: { [s.id]: s },
          settings: { onboardingDone: true },
        }),
      seedSession('axe-1')
    );
    await page.close();
  } catch {
    test.skip(true, 'Playwright browsers no instalados (npx playwright install chromium)');
  }
});

test.afterAll(async () => {
  await context?.close();
});

test('popup: sessions sin violaciones serious/critical', async () => {
  const page = await openExtPage('popup/popup.html');
  await page.waitForSelector('#save-cta', { timeout: 10_000 });
  await expectNoSeriousViolations(page, 'sessions');
  await page.close();
});

test('popup: detail sin violaciones serious/critical', async () => {
  const page = await openExtPage('popup/popup.html');
  const card = page.locator('.session-card[data-id="axe-1"]');
  await card.waitFor({ timeout: 10_000 });
  await card.hover();
  await card.locator('[data-action="detail"]').click();
  await page.waitForSelector('.detail-group');
  await expectNoSeriousViolations(page, 'detail');
  await page.keyboard.press('Escape');
  await page.close();
});

test('popup: settings + save modal sin violaciones serious/critical', async () => {
  const page = await openExtPage('popup/popup.html');
  await page.click('#btn-settings');
  await page.waitForSelector('.settings-panel');
  await expectNoSeriousViolations(page, 'settings');

  await page.locator('.nav-tab[data-view="sessions"]').click();
  await page.click('#save-cta [data-action="open-save-modal"]');
  await page.waitForSelector('#save-modal:not([hidden])');
  await expectNoSeriousViolations(page, 'save-modal');
  await page.keyboard.press('Escape');
  await page.close();
});

test('popup: search, trash y groups sin violaciones serious/critical', async () => {
  const page = await openExtPage('popup/popup.html');
  await page.locator('.nav-tab[data-view="search"]').click();
  await page.waitForSelector('.search-input');
  await expectNoSeriousViolations(page, 'search');

  await page.locator('.nav-tab[data-view="trash"]').click();
  await page.waitForTimeout(200);
  await expectNoSeriousViolations(page, 'trash');

  await page.locator('.nav-tab[data-view="groups"]').click();
  await page.waitForTimeout(200);
  await expectNoSeriousViolations(page, 'groups');
  await page.close();
});

test('side panel: sessions sin violaciones serious/critical', async () => {
  const page = await openExtPage('sidepanel/sidepanel.html');
  await page.waitForSelector('#save-cta', { timeout: 10_000 });
  await expectNoSeriousViolations(page, 'sidepanel:sessions');
  await page.close();
});
