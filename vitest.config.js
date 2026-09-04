import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'node',
    globals: false,
    coverage: {
      reporter: ['text', 'html', 'json', 'json-summary'],
      include: ['shared/**/*.js', 'core/**/*.js', 'background/**/*.js', 'popup/**/*.js', 'ui/**/*.js'],
      // Exclusiones de cobertura unitaria (Fase 10.4), justificadas:
      //  - shared/types.js: solo typedefs JSDoc (cero runtime).
      //  - ui/main.js, ui/events.js, newtab/newtab.js: glue de DOM/bootstrap
      //    cubierto por la suite E2E real (smoke/flows/perf en CI).
      //  - background/sw-main.js: registro de listeners del SW; los handlers
      //    que invoca SÍ están cubiertos (tests/background/*).
      exclude: ['shared/types.js', 'ui/main.js', 'ui/events.js', 'newtab/**', 'background/sw-main.js'],
      thresholds: {
        // Criterio Fase 10.4: ≥70% global, ≥90% en core/.
        global: { statements: 70, branches: 70, functions: 70, lines: 70 },
        'core/**': { statements: 90, branches: 85, functions: 90, lines: 90 },
      },
    },
  },
});
