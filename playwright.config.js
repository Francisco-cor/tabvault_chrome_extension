import { defineConfig } from '@playwright/test';

// Las extensiones requieren contexto persistente con el binario real de Chromium
// (nuevo headless, canal 'chromium' de Playwright). Los navegadores NO se descargan
// en installs locales; en CI: `npx playwright install chromium`.
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
  },
});
