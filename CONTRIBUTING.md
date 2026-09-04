# Contribuir a TabVault

## Setup

```sh
npm install          # solo devDependencies (no hay build)
```

Cargar en Chrome: `chrome://extensions` → modo desarrollador → _Load unpacked_ → carpeta del repo.

## Comandos

| Comando                 | Qué hace                                                                    |
| ----------------------- | --------------------------------------------------------------------------- |
| `npm test`              | Unit tests (Vitest)                                                         |
| `npm run test:coverage` | Unit tests + cobertura (gates: ≥70% global, ≥90% líneas en `core/`)         |
| `npm run lint`          | ESLint — los **errores** fallan; warnings de complejidad son deuda conocida |
| `npm run typecheck`     | TypeScript checkJs sobre `shared/` y `tests/`                               |
| `npm run format`        | Prettier sobre todo el repo                                                 |
| `npm run test:e2e`      | Playwright E2E (requiere `npx playwright install chromium`)                 |
| `npm test -- --watch`   | Tests en watch                                                              |

## Reglas

1. **Conventional Commits**: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`.
2. Todo PR debe pasar CI: lint + typecheck + format + tests + cobertura + E2E.
3. Nada de `innerHTML` con datos sin escapar — la regla `tabvault/safe-html` de ESLint lo fuerza (ver `docs/security.md`).
4. Sin dependencias runtime — devDependencies solamente (ADR-0001).
5. El service worker es el único escritor de estado durable (ADR-0002).
6. Toda URL/favicon persistido pasa por `safeUrl()`/`safeFavicon()` (`core/schema.js`).

## Tests inestables (flaky-quarantine)

1. Si un test falla de forma intermitente, **se marca con `test.skip` + issue
   dedicada con la etiqueta `flaky`** en el mismo PR que lo detecta (no se
   ignora en silencio ni se borra).
2. El test en cuarentena debe **repararse o eliminarse en < 48 h**; la issue es
   el recordatorio visible.
3. Los E2E tienen `retries: 1` en CI: un solo fallo aislado no bloquea; dos
   fallos consecutivos = cuarentena obligatoria.
4. Nunca se sube un test con `retries` propios por encima del config para
   "arreglar" inestabilidad — se arregla la causa (esperas explícitas,
   fixtures deterministas, relojes inyectados).

## Estructura

```
background/   Service worker MV3 (handlers/*)
core/         Dominio puro (repository, schema, search, favicons, stats…)
ui/           Arquitectura de componentes (store, views, actions)
popup/        Fachada de solo lectura + HTML popup
newtab/       Nueva pestaña opt-in
shared/       Mensajes, tipos, utils, logger
tests/        Vitest unit + Playwright E2E (smoke/flows/perf)
docs/adr/     Decisiones de arquitectura
docs/security.md  Modelo de amenazas
ROADMAP.md    Plan de 11 fases
```

## Decisiones

Las decisiones arquitectónicas se documentan como ADRs en `docs/adr/`. Propón una nueva con un PR antes de implementar cambios estructurales.
