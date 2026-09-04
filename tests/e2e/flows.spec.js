// tests/e2e/flows.spec.js — Flujos E2E felices + tristes (Fase 10.4).
// Guardar (vía repo), restaurar, buscar, import corrupto/válido, undo de
// borrado, rutinas y stats — sobre la extensión REAL.

import { test, expect, chromium } from '@playwright/test';
import { launchWithExtension, openExtensionPage, seedVault } from './helpers.js';

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

const ONE_SESSION = {
  flow1: {
    id: 'flow1',
    name: 'Flow docs',
    created: 1_700_000_000_000,
    updated: 1_700_000_000_000,
    groups: [],
    ungroupedTabs: [
      {
        id: 'f1t1',
        url: 'https://github.com/flow/a',
        title: 'GitHub flow',
        favicon: '',
        note: '',
        tags: ['work'],
        savedAt: 1,
      },
      {
        id: 'f1t2',
        url: 'https://docs.example.com/guide',
        title: 'Docs guide',
        favicon: '',
        note: '',
        tags: [],
        savedAt: 2,
      },
    ],
  },
};

test('búsqueda: query encuentra tabs por título y URL', async () => {
  const page = await openExtensionPage(context, extensionId, 'popup/popup.html');
  await seedVault(page, ONE_SESSION);
  await page.reload();
  await page.waitForSelector('.session-card', { timeout: 15_000 });

  await page.locator('.nav-tab[data-view="search"]').click();
  await page.locator('.search-input').fill('github');
  await expect(page.locator('.search-tab-item').first()).toBeVisible({ timeout: 7_000 });
  await expect(page.locator('.search-tab-title').first()).toContainText('GitHub flow');
  await page.close();
});

test('búsqueda sin resultados muestra empty state (sad)', async () => {
  const page = await openExtensionPage(context, extensionId, 'popup/popup.html');
  await seedVault(page, ONE_SESSION);
  await page.reload();
  await page.waitForSelector('.session-card', { timeout: 15_000 });

  await page.locator('.nav-tab[data-view="search"]').click();
  await page.locator('.search-input').fill('zzzznada');
  await expect(page.locator('.empty-state')).toBeVisible({ timeout: 7_000 });
  await page.close();
});

test('import corrupto: JSON inválido → toast de error, storage intacto (sad)', async () => {
  const page = await openExtensionPage(context, extensionId, 'popup/popup.html');
  await seedVault(page, ONE_SESSION);
  await page.reload();
  await page.waitForSelector('.session-card', { timeout: 15_000 });

  await page.setInputFiles('#import-file', {
    name: 'corrupt.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{ esto no es json ]'),
  });
  await expect(page.locator('#toast')).toContainText('Invalid JSON file', { timeout: 7_000 });

  const sessions = await page.evaluate(() => chrome.storage.local.get('sessions'));
  expect(Object.keys(sessions.sessions ?? {})).toEqual(['flow1']);
  await page.close();
});

test('import válido: preview modal → confirmar → sesión añadida (happy)', async () => {
  const page = await openExtensionPage(context, extensionId, 'popup/popup.html');
  await seedVault(page, ONE_SESSION);
  await page.reload();
  await page.waitForSelector('.session-card', { timeout: 15_000 });

  const incoming = {
    _tabvault: true,
    version: 4,
    sessions: {
      incoming1: {
        id: 'incoming1',
        name: 'Imported session',
        created: 1,
        updated: 1,
        groups: [],
        ungroupedTabs: [
          {
            id: 'i1',
            url: 'https://imported.example.com/x',
            title: 'Imported tab',
            favicon: '',
            note: '',
            tags: [],
            savedAt: 1,
          },
        ],
      },
    },
  };
  await page.setInputFiles('#import-file', {
    name: 'backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(incoming)),
  });
  await expect(page.locator('#import-modal')).toBeVisible({ timeout: 7_000 });
  await page.locator('#import-confirm').click();

  await expect(page.locator('.session-card[data-id="incoming1"]')).toBeVisible({ timeout: 7_000 });
  await page.close();
});

test('borrar con undo: undo restaura la sesión (happy)', async () => {
  const page = await openExtensionPage(context, extensionId, 'popup/popup.html');
  await seedVault(page, ONE_SESSION);
  await page.reload();
  await page.waitForSelector('.session-card', { timeout: 15_000 });

  await page.locator('.session-card[data-id="flow1"] [data-action="delete"]').click();
  await expect(page.locator('#undo-toast')).toBeVisible({ timeout: 7_000 });
  await expect(page.locator('.session-card[data-id="flow1"]')).toHaveCount(0);

  await page.locator('#undo-btn').click();
  await expect(page.locator('.session-card[data-id="flow1"]')).toBeVisible({ timeout: 7_000 });
  const dump = await page.evaluate(() => chrome.storage.local.get('sessions'));
  expect(dump.sessions.flow1).toBeTruthy();
  await page.close();
});

test('restaurar sesión: abre ventana nueva con las tabs (happy)', async () => {
  const page = await openExtensionPage(context, extensionId, 'popup/popup.html');
  await seedVault(page, ONE_SESSION);
  await page.reload();
  await page.waitForSelector('.session-card', { timeout: 15_000 });

  await page.locator('.session-card[data-id="flow1"] [data-action="restore"]').click();

  await expect
    .poll(
      () =>
        page.evaluate(
          async () =>
            (await chrome.windows.getAll({ populate: true })).filter((/** @type {any} */ w) =>
              (w.tabs ?? []).some((/** @type {any} */ t) =>
                (t.url ?? '').startsWith('https://github.com/flow')
              )
            ).length
        ),
      { timeout: 15_000 }
    )
    .toBeGreaterThanOrEqual(1);
  await page.close();
});

test('rutina: programar sesión → fila visible con próxima ejecución (happy)', async () => {
  const page = await openExtensionPage(context, extensionId, 'popup/popup.html');
  await seedVault(page, ONE_SESSION);
  await page.reload();
  await page.waitForSelector('.session-card', { timeout: 15_000 });

  await page.locator('#btn-settings').click();
  const select = page.locator('#routine-session-select');
  await expect(select).toBeVisible({ timeout: 7_000 });
  await select.selectOption('flow1');
  await page.locator('#routine-time-input').fill('07:30');
  await page.locator('[data-action="add-routine"]').click();

  await expect(page.locator('.routine-row')).toHaveCount(1, { timeout: 7_000 });
  await expect(page.locator('.routine-row')).toContainText('07:30');
  await page.close();
});

test('stats: KPIs y top dominios sobre el vault sembrado (happy)', async () => {
  const page = await openExtensionPage(context, extensionId, 'popup/popup.html');
  await seedVault(page, ONE_SESSION);
  await page.reload();
  await page.waitForSelector('.session-card', { timeout: 15_000 });

  await page.locator('.nav-tab[data-view="stats"]').click();
  await expect(page.locator('.stats-view')).toBeVisible({ timeout: 7_000 });
  await expect(page.locator('.stat-card').first()).toContainText('1'); // ≥1 sesión
  await expect(page.locator('.stats-bar-label').first()).toBeVisible({ timeout: 7_000 });
  await page.close();
});
