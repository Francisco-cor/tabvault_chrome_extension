# ADR-0001: Sin paso de build (ES modules nativos)

- Estado: Aceptado
- Fecha: 2026-08-22
- Decide: Mantener el código fuente como ES modules ejecutables directamente por Chrome, sin bundler ni transpilación.

## Contexto

TabVault es una extensión MV3 pequeña (~2.500 líneas). Chrome soporta ES modules de forma nativa en service workers (`"type": "module"`) y en páginas de extensión (`<script type="module">`). Un build con Vite/CRXJS aportaría HMR y minificación, pero añade dependencias, tiempo de configuración y un desvío entre código fuente y código publicado.

## Decisión

1. **No hay runtime transformado**: `manifest.json` apunta a archivos `.js` reales; lo que se carga en Chrome es lo que está en el repo.
2. El tooling (ESLint, Prettier, Vitest, Playwright, TypeScript en modo `checkJs`) vive solo como **devDependencies**.
3. Los tests importan los módulos fuente directamente (`import { searchSessions } from '../shared/utils.js'`), sin pipeline intermedio.
4. Si algún día se necesita minificación para la store, se añade un paso opcional `npm run zip` que empaqueta sin transformar.

## Consecuencias

- Cero desvío fuente/producción; debugging directo contra el código real.
- Onboarding trivial: clonar, `npm install` (solo devDeps), cargar en `chrome://extensions`.
- Sin sourcemaps, sin hashes, sin cache-busting.
  − No hay tree-shaking ni minificación automática (irrelevante a esta escala).
  − Los imports deben usar rutas relativas con extensión `.js` explícita.

## Alternativas descartadas

- **Vite + @crxjs/vite-plugin**: excelente DX pero introduce ciclo build/watch obligatorio y versiones que rompen con frecuencia ante cambios MV3.
- **Webpack**: peso de configuración injustificado para este tamaño.
