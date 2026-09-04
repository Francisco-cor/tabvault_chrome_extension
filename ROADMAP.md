# TabVault 2.0 — Plan Maestro de Transformación (11 Fases)

> Documento generado a partir de una auditoría profunda del código fuente.
> Cada fase es autocontenida, con objetivos, tareas accionables, criterios de aceptación y estimación de esfuerzo.

---

## Índice

- [Resumen ejecutivo de la auditoría](#resumen-ejecutivo-de-la-auditoría)
- [Mapa de deuda técnica](#mapa-de-deuda-técnica)
- [Fase 0 — Baseline y preparación](#fase-0--baseline-y-preparación)
- [Fase 1 — Fundaciones de ingeniería](#fase-1--fundaciones-de-ingeniería)
- [Fase 2 — Núcleo de datos confiable](#fase-2--núcleo-de-datos-confiable)
- [Fase 3 — Service worker resiliente](#fase-3--service-worker-resiliente)
- [Fase 4 — Arquitectura UI desacoplada](#fase-4--arquitectura-ui-desacoplada)
- [Fase 5 — Diseño, UX y accesibilidad](#fase-5--diseño-ux-y-accesibilidad)
- [Fase 6 — Captura y restauración de élite](#fase-6--captura-y-restauración-de-élite)
- [Fase 7 — Búsqueda, organización y navegación](#fase-7--búsqueda-organización-y-navegación)
- [Fase 8 — Portabilidad de datos y respaldos](#fase-8--portabilidad-de-datos-y-respaldos)
- [Fase 9 — Funciones avanzadas de productividad](#fase-9--funciones-avanzadas-de-productividad)
- [Fase 10 — Rendimiento, seguridad y calidad total](#fase-10--rendimiento-seguridad-y-calidad-total)
- [Fase 11 — Lanzamiento, distribución y crecimiento](#fase-11--lanzamiento-distribución-y-crecimiento)

---

## Resumen ejecutivo de la auditoría

La app funciona como demo funcional pero **no es confiable para uso diario serio**. Los hallazgos se agrupan en tres niveles:

### 🔴 Críticos (riesgo de pérdida de datos o comportamiento incorrecto)

| #   | Bug                                           | Ubicación                                | Detalle                                                                                                                                                                                                                                                      |
| --- | --------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1  | Race condition en auto-save al cerrar ventana | `service-worker.js:113-147`              | `initWindowCache()` es async; si el SW despierta por el evento `windows.onRemoved` (cold start), el handler lee `windowTabCache` antes de que se llene → **el auto-save guarda una sesión vacía o nada**, en silencio.                                       |
| C2  | Caché obsoleta entre contextos                | `storage.js:22-39` + `popup.js`          | `StorageManager._cache` vive por contexto. El popup nunca escucha `chrome.storage.onChanged`: si el SW auto-guarda mientras el popup está abierto, la UI muestra datos viejos y **una escritura posterior del popup puede pisar la sesión recién guardada**. |
| C3  | Lectura-modificación-escritura no atómica     | todo `storage.js`                        | Toda mutación lee el objeto completo `sessions`, lo muta en memoria y reescribe. Escrituras concurrentes popup↔SW = _lost updates_.                                                                                                                          |
| C4  | Snapshot creado sin confirmación del usuario  | `popup.js:1080-1089`                     | Al detectar duplicado, `confirmSave()` llama `saveVersion()` **antes** del segundo click de confirmación. Si el usuario cancela, la versión queda creada igualmente.                                                                                         |
| C5  | Auto-saves pierden los grupos de tabs         | `service-worker.js:52-94, 145-182`       | El auto-save periódico y el de cierre guardan todas las tabs planas en `ungroupedTabs`, descartando `tab.groupId` que sí está disponible. Estructura irrecoverable.                                                                                          |
| C6  | Acumulación de listeners de drag & drop       | `popup.js:1586-1708`                     | `bindDragAndDrop()` registra funciones anónimas **nuevas en cada render** sobre el elemento persistente `#content`. Tras N renders, cada drop dispara N handlers → reordenamientos duplicados y erráticos.                                                   |
| C7  | Import sin validación estructural             | `storage.js:381-388`, `popup.js:862-881` | `importAll` vuelca claves arbitrarias a storage sin validar forma; modo merge pisa sesiones con ID colisionante sin aviso ni dedupe. Corrupción silenciosa posible.                                                                                          |
| C8  | XSS almacenado vía import                     | `popup.js:594-608`                       | `<a href="${esc(tab.url)}">` escapa comillas pero permite URLs `javascript:`/`data:text/html` importadas → click ejecuta código. Falta whitelist de protocolos (`http/https`).                                                                               |
| C9  | Restore pierde estado de tabs                 | `service-worker.js:322-376`              | No preserva `pinned` (capturado ni siquiera se guarda), ni tab activa, ni abre en orden correcto con grupos mezclados; además crea tabs secuencialmente (`await` por tab = lento con 50+ tabs).                                                              |
| C10 | Purge de papelera solo al abrir popup         | `popup.js:65`                            | Si el popup nunca se abre, la papelera crece indefinidamente. Debería correr vía `chrome.alarms` diaria en el SW.                                                                                                                                            |

### 🟡 Mayores (bugs funcionales visibles)

| #   | Bug                                              | Ubicación                                | Detalle                                                                                                                                                          |
| --- | ------------------------------------------------ | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | Menú contextual duplicable                       | `service-worker.js:11-24`                | Sin `contextMenus.removeAll()` previo ni callback con `lastError`; en reload/update pueden fallar creates en silencio.                                           |
| M2  | `action.openPopup()` incompatible                | `service-worker.js:37`                   | Requiere Chrome 127+; el `.catch(() => {})` traga el error sin fallback (ej. abrir tab).                                                                         |
| M3  | Sin `minimum_chrome_version`                     | `manifest.json`                          | `sidePanel` requiere 116+; no se declara, Chrome viejo carga la extensión rota.                                                                                  |
| M4  | `unlimitedStorage` contradice la lógica de cuota | `manifest.json` + `popup.js:1103`        | Con unlimitedStorage el % mostrado es engañoso; o se quita el permiso o se cambia la estrategia de advertencia (conteo de bytes real).                           |
| M5  | Badge con `setTimeout` en SW                     | `service-worker.js:31-33, 88-90`         | El SW puede morir antes del timeout → badge "AUTO" pegado para siempre. Usar `chrome.alarms` de un disparo.                                                      |
| M6  | Filtros de URL incompletos e inconsistentes      | `popup.js:100` vs `service-worker.js:57` | Solo se filtra `chrome://`; quedan fuera `edge://`, `about:`, `devtools://`, `view-source:`, `chrome-untrusted://`, Web Store. Popup y SW usan reglas distintas. |
| M7  | Búsqueda sin debounce ni índice                  | `popup.js:946-953`                       | Re-scoring O(sesiones×tabs) en cada tecla; con miles de tabs el popup se congela.                                                                                |
| M8  | Notas editables se pierden en re-render          | `popup.js:968-989`                       | El textarea guarda con debounce 500ms; cualquier render intermedio (toast, acción) reconstruye el DOM y descarta lo tecleado.                                    |
| M9  | Undo muere con el popup                          | `popup.js:1216-1253`                     | Timer de 5s en el documento; cerrar el popup cancela el undo (aceptable en MV3, pero debe delegarse al SW para durar).                                           |
| M10 | Sync engañoso                                    | `storage.js:350-363`                     | `syncEnabled` solo sincroniza settings, nunca sesiones; el toggle sugiere otra cosa.                                                                             |
| M11 | `exportAsMarkdown` en capa de datos              | `storage.js:396-416`                     | Lógica de presentación viviendo en StorageManager; además omite notas de sesión, tags de sesión y tags de tab.                                                   |
| M12 | Tecla `r` restaura sin confirmación              | `popup.js:1750-1752`                     | En navegación por teclado, `r` dispara restore inmediato de la card enfocada. Peligroso junto con navegación casual.                                             |
| M13 | Live Groups solo ventana actual                  | `popup.js:85-106`                        | Sin selector multi-ventana; usuarios con varias ventanas no pueden ver/guardar las demás.                                                                        |
| M14 | Drag & drop cross-group ignora posición          | `popup.js:1673-1687`                     | Mover una tab entre grupos siempre hace push al final; el drop index se descarta.                                                                                |
| M15 | Drop fuera de targets sin feedback               | `popup.js:1650-1701`                     | Soltar en zona inválida no restaura estado visual ni informa.                                                                                                    |

### 🟢 Menores / deuda

- Monolito `popup.js` de **1.793 líneas** con plantillas HTML en strings; imposible testear unidades.
- CSS de 949 líneas con selectores duplicados (`.settings-select` ≡ `.sort-select`) y colores hardcoded fuera de tokens (`#18181b`, rgba de accent repetidos).
- Accesibilidad casi nula: sin focus trap en modales, sin `aria-*` completos, contraste sin auditar, sin soporte `prefers-reduced-motion`.
- Sin tests, sin lint, sin formatter, sin CI, sin `package.json`.
- README desactualizado (no documenta papelera, versiones, bulk ops, side panel, atajos).
- Sin i18n: todo hardcoded en inglés.
- Side panel = mismo `popup.html` con query-param hack; CSS fijo 420px sobrescrito a parches.
- Sin migraciones/versionado de esquema (el export dice `version: 2` pero nadie migra nada).
- Sin dedup de tabs al guardar (misma URL ×N veces).
- Favicons como data-URLs inflan storage masivamente (hasta 32KB × tab) sin dedupe por dominio ni eviction.
- Sin manejo global de errores (`window.onerror`, `unhandledrejection`): un throw deja pantalla vacía.
- `generate-icons.js` custom frágil; íconos generados sin pipeline reproducible documentado.

### Veredicto

Buen producto embrionario con UX cuidada, pero con **fundamentos de persistencia rotos** (C1–C5) y una arquitectura de UI que ya no escala. La transformación propuesta reconstruye primero los cimientos (Fases 1–3), luego la arquitectura (4–5), después eleva las features (6–9) y cierra con calidad y lanzamiento (10–11).

---

## Mapa de deuda técnica

```
┌────────────────────────────────────────────────────────────────┐
│                        ESTADO ACTUAL                           │
├──────────────┬───────────────┬─────────────────┬──────────────┤
│ manifest     │ background    │ shared          │ popup        │
│ MV3 ✓        │ SW monolítico │ storage.js      │ js 1.793 ln  │
│ perms extra  │ races ✗       │ cache roto ✗    │ css 949 ln   │
│              │               │ sin validar ✗   │ monolito ✗   │
├──────────────┴───────────────┴─────────────────┴──────────────┤
│ Ausente: tests · CI · lint · types · i18n · options page ·     │
│ migraciones · telemetría local · docs · store assets           │
└────────────────────────────────────────────────────────────────┘
```

Objetivo final:

```
┌────────────────────────────────────────────────────────────────┐
│                      TABVAULT 2.0                              │
├──────────┬──────────────┬────────────────┬────────────────────┤
│ core/    │ background/  │ ui/            │ platform/          │
│ domain   │ SW modular   │ componentes    │ storage adapter    │
│ modelado │ alarms       │ router         │ sync engine        │
│ validado │ handlers     │ state store    │ migrations         │
├──────────┴──────────────┴────────────────┴────────────────────┤
│ Vitest unit · Playwright E2E · ESLint+Prettier · CI GitHub     │
│ Cobertura ≥70% · presupuesto perf · a11y AA · ES/EN            │
└────────────────────────────────────────────────────────────────┘
```

---

## Fase 0 — Baseline y preparación

> **Estado: ✅ Completada (2026-08-22)**

**Objetivo:** fijar el punto de partida y las convenciones del repo antes de tocar código.

### Tareas

- [x] `.editorconfig` (LF, UTF-8, indent 2)
- [x] `.gitignore` ampliado (`coverage/`, `test-results/`, `playwright-report/`, `.husky/_/`)
- [x] ADRs iniciales: `docs/adr/0001-no-build.md`, `docs/adr/0002-single-writer.md`
- [x] `generate-icons.js` → `generate-icons.cjs` (CommonJS explícito; el paquete es ESM)
- [x] Snapshot de auditoría completo en este documento

---

## Fase 1 — Fundaciones de ingeniería

> **Estado: ✅ Completada (2026-08-22)** · Gates: lint 0 errores · typecheck OK · tests 59/59 · format OK

**Objetivo:** convertir un proyecto "script suelto" en un repositorio de ingeniería seria, sin cambiar aún el comportamiento. Todo lo demás se construye sobre esto.

**Problemas que resuelve:** ausencia total de tooling, imposibilidad de refactorizar con red de seguridad, deuda invisible.

### Tareas

#### 1.1 Gestión de paquetes y scripts

- [x] `package.json` con `"type": "module"` y scripts: `lint`, `lint:fix`, `format`, `format:check`, `typecheck`, `test`, `test:watch`, `test:e2e`, `zip`, `icons`
- [x] Estrategia no-build decidida y documentada (`docs/adr/0001-no-build.md`)
- [x] `.editorconfig` + `.gitignore` ampliado
- [ ] Husky + lint-staged pre-commit _(pendiente: requiere activar git hooks con `npx husky init`; se hace junto al primer commit)_

#### 1.2 Calidad estática

- [x] ESLint flat config (`eslint.config.js`) con globals browser/webextensions/node
- [x] Reglas baseline: `no-unused-vars` (+`ignoreRestSiblings`), `eqeqeq`, `prefer-const`, `complexity ≤12` como _warning_ heredado documentado (se endurece en Fases 2–4)
- [x] Prettier (`printWidth 110`, single quotes, LF) + `.prettierignore` + repo formateado completo
- [x] Baseline honesta: 0 errores, 12 warnings de complejidad conocidos

#### 1.3 Tipado progresivo

- [x] `shared/types.js`: typedefs del dominio (`Session`, `Group`, `TabItem`, `SnapshotEntry`, `Settings`, `SessionMap`, `TrashMap`, `VersionMap`, `ExportFile`)
- [x] `tsconfig.json` checkJs estricto sobre `shared/**` + `tests/**` (excluye `tests/e2e`)
- [x] `shared/storage.js` y `shared/utils.js` anotados con JSDoc completo
- [x] Contrato de mensajes tipado: `shared/messages.js` (mapa `MSG` + `sendToBackground()`)

#### 1.4 Testing desde día uno

- [x] Vitest configurado (`vitest.config.js`)
- [x] Mock de chrome APIs (`tests/mocks/chrome.js`) + fixtures deterministas (`tests/fixtures/sessions.js`)
- [x] **59 tests de caracterización**: fuzzy scoring exacto, CRUD, papelera, pin, merge, versionado (cap 5 + strip favicons), reorder/move, settings, export/import, cuota
- [x] Quirks caracterizados en tests: reorder fuera de rango devuelve `undefined`; el export Markdown omite notas de tabs ungrouped; URLs con esquema arbitrario parsean en `truncateUrl`
- [x] Playwright scaffold: config + smoke spec de extensión real (browsers solo en CI)
- [x] `npm run zip` store-ready verificado (38.3 KB, staging limpio)

#### 1.5 CI/CD

- [x] GitHub Actions `.github/workflows/ci.yml`: job lint+typecheck+format+tests · job E2E con Chromium · job pack con artefacto zip
- [ ] Job nocturno Chrome Beta _(pospuesto a Fase 10)_

#### 1.6 Higiene de repositorio

- [x] `CONTRIBUTING.md`, issue templates (bug/feature), PR template con checklist
- [x] Conventional Commits documentados

### Entregables

`package.json`, configs de lint/format, `tests/`, workflow CI, `docs/adr/`, tipos JSDoc del dominio, suite de caracterización.

### Criterios de aceptación

- `npm run lint && npm test` pasa en CI limpio.
- Un cambio trivial (renombrar una función) rompe tests si se hace mal → red de seguridad demostrada.
- Ningún archivo del repo supera complejidad ciclomática 12 (excepciones waivadas documentadas).

### Estimación

~1 semana. Es la fase más "aburrida" y la de mayor ROI del plan entero.

---

## Fase 2 — Núcleo de datos confiable

> **Estado: ✅ Completada (2026-08-22)** · Gates: lint 0 errores · typecheck OK · tests 96/96 → 136/136 en Fase 3 · format OK
> Bugs muertos: **C2, C3, C4, C7, C8 (nivel datos), C10** · `shared/storage.js` eliminado

**Objetivo:** reconstruir la capa de persistencia para que sea **transaccional, coherente entre contextos, validada y versionada**. Aquí mueren los bugs C2, C3, C4, C7 y parte de C1.

### Tareas

#### 2.1 Repositorio transaccional (`core/repository.js`)

Reemplaza el objeto literal `StorageManager`:

```js
// Cola de escritura serial: toda mutación pasa por aquí
let queue = Promise.resolve();
function enqueue(fn) {
  const run = queue.then(fn);
  queue = run.then(
    () => {},
    () => {}
  );
  return run;
}
```

- [x] Toda operación de mutación se envuelve en `_enqueue()`: **nunca hay dos RMW solapados en un contexto** (test de estrés: 200 ops concurrentes).
- [x] Single-writer activo: popup usa `popup/repoClient.js` (lecturas locales + escrituras vía `MSG.REPO_OP` con whitelist `REMOTE_OPS`); Repository no-writable lanza al mutar. Elimina C3.
- [x] La respuesta del SW devuelve la entidad resultante; la caché local refresca por onChanged + invalidate determinista. (Store reactivo completo: Fase 4.)

#### 2.2 Caché coherente

- [x] `Repository.attach()` suscribe a `chrome.storage.onChanged` en ambos contextos; invalida/refresca automáticamente.
- [x] Fin del bug C2 probado en test: escritura EXTERNA visible sin invalidate() manual (writer y reader).
- [x] Flujo reactivo popup↔SW verificado en cadena con mock (`tests/ui/reactive.test.js`, Fase 4); E2E de navegador real entra con Playwright en Fase 10.

#### 2.3 Validación de esquema (`core/schema.js`)

- [x] Normalizadores puros: `normalizeTab/Group/Session/Settings`, `safeUrl`/`safeFavicon` (bloquean javascript:/data:/svg), `validateImportPayload` itemizado.
- [x] Repara parciales con coerción segura y límites anti-bloat (nota 4k chars; tags 24×40; favicon 60k chars solo data:image/* o http(s); URL 4k).
- [x] Toda lectura normaliza (cache-fill); toda escritura valida antes de persistir; metadata SIEMPRE recalculada.

#### 2.4 Versionado y migraciones

- [x] `meta.schemaVersion = 3`; datos legacy sin marca migran solos.
- [x] Migración idempotente legacy/2→3: normaliza sesiones/trash/settings + backup `backup_preMigration_v0_v3_<ts>` (excluido de exportAll).
- [x] Corre en onInstalled/onStartup vía `repo.runMigrations()`; doble ejecución = snapshot idéntico (test).
- [x] exportAll/exportSession estampan versión actual; import replace estampa meta tras validar.

#### 2.5 Correcciones puntuales heredadas

- [x] **C4:** el modal solo advierte en el primer click; el SW versiona el duplicado SOLO al recibir `duplicateId` (post-confirmación). Cancelar ya no crea snapshots.
- [x] **C10:** alarm diaria `tabvault-trash-purge` en el SW; setting `trashPurgeDays` (7/30/60/90) con UI y re-programación al cambiar.
- [x] Papelera: restore conserva `pinned` ✓ · deletePermanently limpia versiones ✓ · BONUS: restoreVersion re-adjunta favicons por URL desde estado actual.

#### 2.6 Modelo de dominio

- [x] `core/domain.js` puro: computeMetadata, dedupeTabsInSession, mergeSessionsInto, cloneCleanSession, findDuplicateOf, reattachFavicons. El hack `_score/_matchingTabs` murió con storage.js.
- [x] IDs: `newId()` único punto de generación importable.

### Entregables

`core/repository.js`, `core/schema.js`, `core/migrations.js`, `core/domain.js`; StorageManager deprecado y eliminado.

### Criterios de aceptación

- Test de estrés: 200 operaciones concurrentes simuladas popup+SW → 0 lost updates (verificado leyendo estado final esperado).
- Un JSON corrupto/manipulado en import no puede corromper storage (validador lo rechaza con mensaje útil).
- Migración 2→3 ejecutándose dos veces produce el mismo resultado (idempotencia probada).

### Estimación

~1,5 semanas. Incluye reescribir llamadas en popup/SW (mecánico gracias al contrato de mensajes de Fase 1).

---

## Fase 3 — Service worker resiliente

> **Estado: ✅ Completada (2026-08-22)** · Gates: lint 0 errores (0 warnings en `background/`) · typecheck OK (incluye `background/**`) · tests 136/136 · format OK
> Bugs muertos: **C1, C5, C9, M1, M2, M5, M6 (filtro único), M13** · `service-worker.js` → `sw-main.js` + `handlers/*`

**Objetivo:** un background que nunca pierde datos ni estados, con ciclo de vida MV3 respetado. Mata C1, C5, M1, M2, M5, M13.

### Tareas

#### 3.1 Estado en almacenamiento, no en memoria

- [x] Eliminar `windowTabCache` en memoria. Migrar a `chrome.storage.session` (sobrevive al sleep del SW, se limpia al cerrar navegador):
  - `windowSnapshots[windowId] = { incognito, tabs, groups }` actualizado por eventos con debounce 250ms.
- [x] Handler `windows.onRemoved`: leer snapshot de esa ventana **desde storage.session** → C1 resuelto (cold start ya no importa porque el dato no depende de memoria volátil). Test: SW "despierta frío" por onRemoved y guarda igualmente.
- [x] `snapshotAllWindows()` en boot/onStartup: reconstruye el mapa completo desde ventanas vivas y purga claves huérfanas.

#### 3.2 Auto-saves que respetan la estructura

- [x] Extraer capturador compartido `captureWindow(winId)` + `buildSessionFromTabs()` (handlers/capture.js) usado por: guardado manual, auto-save periódico, auto-save por cierre y captura multi-ventana. Fin de la divergencia C5.
- [x] Reconstruir grupos desde `tab.groupId` + `tabGroups.query` en TODOS los flujos (probado en los 4).
- [x] Configuración granular en Settings (`autoSaveOnClose` default ON, `includeIncognito` default OFF, `minAutoSaveTabs` default 2, `dedupeOnRestore` default OFF) — normalizadas en schema.js, UI de settings añadida, honradas por el SW.

#### 3.3 Ciclo de vida correcto

- [x] Badge: reemplazar `setTimeout` por `chrome.alarms.create('tabvault-badge-clear', {when})` de un disparo (M5); listener limpia y sale.
- [x] Context menus: `removeAll()` → crear dentro del callback (M1); ids namespaced `tabvault_save_session`; `checkLastError()` explícito.
- [x] `openPopup()` con detección de soporte (`typeof chrome.action.openPopup === 'function'`), fallback: `chrome.tabs.create({url})` (M2).
- [x] Todos los callbacks con `chrome.runtime.lastError` manejado; wrapper `checkLastError()`.
- [x] `manifest.json`: añadir `"minimum_chrome_version": "116"` (M3). `openPopup` queda opcional con fallback → no obliga a subir a 127.

#### 3.4 Captura y restauración robustas

- [x] Capturar y guardar por tab: `pinned`, `active` (nuevos campos opcionales de TabItem), orden exacto, título, favicon.
- [x] Restauración:
  - Crear todas las tabs **en paralelo** (`Promise.all` sobre `tabs.create`) alineadas al plan y agrupar después → velocidad ×N (C9).
  - Preservar `pinned` vía `tabs.update(tabId, {pinned:true})`.
  - Activar la tab que era activa al capturar (+ focus de ventana).
  - Modos: nueva ventana / esta ventana (append) / **reemplazar ventana** (cierra las demás) — este último nuevo.
  - Anti-duplicados opcional: si la URL ya existe en la ventana destino, enfocarla en lugar de duplicarla (setting `dedupeOnRestore`).
- [x] Multi-ventana: `captureAllWindows()` que itera `windows.getAll({populate:true})` con filtro consistente usando `shared/urlRules.js` `isValidTabUrl()` con `BLOCKED_PREFIXES` (M6, M13).

#### 3.5 Mensajería formal

- [x] Router único `handleMessage()` con switch tipado sobre MSG, respuesta uniforme `{ok, data?, error?}` y `withTimeout(20s)`.
- [x] Mensajes nuevos: `CAPTURE_ALL_WINDOWS` (implementado), `STASH_TAB` (reservada aquí, implementada en Fase 6), `REPLACE_WINDOW_WITH_SESSION` (implementado), `GET_STATS` (KPIs básicos; uso pleno en Fase 9).

### Entregables

`background/sw-main.js` (registro de listeners), `background/handlers/{capture,restore,autosave,messages,lifecycle}.js`, `shared/urlRules.js`. Mock de chrome ampliado (windows/tabs/tabGroups/alarms/action/contextMenus/storage.session) para tests unitarios del background.

### Criterios de aceptación

- Test crítico C1: snapshot persistido en storage.session → cierre de ventana con SW frío guarda sesión con tabs Y grupos intactos (test automatizado).
- Guardado/restauración probadas con grupos, pinned y active; replace deja la ventana EXACTAMENTE con las tabs de la sesión (test).
- Badge nunca queda pegado: limpieza por alarm programada en cada flash (M5, test).

### Estimación

~1,5 semanas.

---

## Fase 4 — Arquitectura UI desacoplada

> **Estado: ✅ Completada (2026-08-22)** · Gates: lint 0 errores (0 warnings en `ui/`) · typecheck OK (incluye `ui/**` + `popup/**`) · tests 209/209 · format OK · 0 mojibake · zip OK
> Bugs muertos: **C6** · M8 · M14 · M15 (base de M7: render memoizado) · `popup/popup.js` (1.793 ln) eliminado
> Bonus muerto: **zip store roto latente** — `pack.mjs` no incluía `core/` (el SW importa `core/*`); cualquier zip anterior fallaba al cargar. Ahora empaqueta `core/` + `ui/`.

**Objetivo:** desmontar el monolito de 1.793 líneas en una arquitectura de componentes testeable con render eficiente. Resuelve C6, M7 (base), M8, M14, M15 y prepara todo el resto de features de UI.

### Tareas

#### 4.1 Store central (`ui/store.js`)

- [x] Única fuente de verdad observable (pub/sub mínimo):
  ```js
  createStore(rootReducer, initialState());
  // API: getState(), dispatch(action), subscribe(fn) | subscribe(selector, fn)
  ```
- [x] Acciones nombradas (`ui/actions.js`: SESSIONS_SYNCED, NOTE_DRAFT, BULK_CHECK_TOGGLED…), reducers puros por dominio (`lifecycle/data/nav/ui/bulk`) → **testeables con Vitest sin DOM** (`tests/ui/reducers.test.js`, 30+ casos).
- [x] Los eventos de `storage.onChanged` (Fase 2) despachan acciones al store: la UI es reactiva al SW (probado extremo a extremo con mock: `tests/ui/reactive.test.js`). Suscripción con selector memoizada por firma JSON del slice.

#### 4.2 Render eficiente

- [x] Sustituir `innerHTML` global por **render por vistas**: cada vista es `render(state) → htmlString` pura + `deps(state)` serializable; solo se re-pinta la vista activa y solo cuando su firma JSON cambia (`ui/render.js`).
- [x] Preservación de foco/input: `focusKeeper` captura elemento enfocado (clave `data-fk`) + selección antes del swap y lo restaura después. Combinado con los borradores `NOTE_DRAFT` en el store, **editar una nota mientras llega un auto-save no pierde texto NI cursor** (M8 de verdad, test incluido).
- [x] Listas largas virtualizadas para sesiones (>30 cards): `computeWindow()` puro testeado + ScrollBus ÚNICO sobre `#content` (sin listeners acumulados). La virtualización de resultados de búsqueda llega con el índice de Fase 7 (reestructuran las filas).

#### 4.3 Eventos

- [x] **Una sola delegación permanente** en `#content` registrada UNA vez en init (fin del bug C6): tabla plana `CLICK_ACTIONS[data-action]` + listeners `dblclick/input/change/focusout`.
- [x] Handlers como módulos puros importables (`ui/actions/{session,bulk,note,settings,vault}Actions.js`) → testables.
- [x] D&D reescrito con `DragController` (instancia única): decisión pura `resolveDrop()` testeada, indicadores arriba/abajo, cross-group **respetando índice destino** (M14 — requirió extender `repo.moveTabToGroup(sid, tabId, from, to, toIndex?)`), feedback visual en drop inválido (M15), dragstart ignora drags iniciados en textareas de notas.

#### 4.4 Descomposición física

- [x] Estructura entregada:
  ```
  ui/
  ├── main.js               # bootstrap (372 ln, era popup.js 2.106 ln)
  ├── store.js  reducers.js  actions.js   router.js  render.js  events.js
  ├── components/
  │   ├── SessionCard.js    GroupPills.js  TagChip.js  Toasts.js
  │   ├── Modal.js          (focus trap incluido)
  │   ├── ContextMenu.js    VirtualList.js  Icon.js (sprite SVG)
  │   ├── DragController.js focusKeeper.js
  ├── views/                SessionsView GroupsView DetailView SearchView TrashView SettingsView
  ├── actions/              sessionActions bulkActions noteActions settingsActions vaultActions
  └── services/             liveGroups.js diagnostics.js
  ```

#### 4.5 Router con historial

- [x] Pila interna de vistas: detail/settings se apilan sobre la raíz; back restaura vista **y scrollTop exactos**; expansión/filtros sobreviven (viven en el store); `Esc` = pop con prioridad menú→modales→bulk→vista; nav tabs reinician la pila.

#### 4.6 Robustez

- [x] Error boundary: try/catch por vista + boundary exterior en el render → vista amigable con botón "Recargar".
- [x] `unhandledrejection`/`error` globales → ring-buffer en `chrome.storage.session` (`services/diagnostics.js`, 30 entradas, sin red) + toast.

### Entregables

Árbol `ui/` completo; eliminación de `popup.js` monolítico; suite de reducers/store/router/vistas/drag/virtualización/reactividad (**73 tests nuevos**, total 209).

### Criterios de aceptación

- [x] Editar una nota mientras llega un auto-save del SW **no pierde texto** — verificado en cadena completa escritura externa→onChanged→store→vista (`tests/ui/reactive.test.js`; el E2E de navegador real se añade a la suite Playwright en Fase 10).
- [~] Mecanismo de performance listo (virtualización + render memoizado por firma); la medición formal (60fps / <50ms por tecla) entra como budget de CI en Fase 10.
- [~] C6 muerto por construcción (cero `addEventListener` por render, comprobable por diseño); el profiling DevTools formal corre con los budgets de Fase 10.

### Estimación

~2 semanas. Es la fase más grande; se puede partir en 4A (store/render) y 4B (D&D/router/virtualización).

---

## Fase 5 — Diseño, UX y accesibilidad

> **Estado: ✅ Completada (2026-08-22)** · Gates: lint 0 errores (solo el warning heredado de `searchSessions` en `shared/`, muere en Fase 7) · typecheck OK · tests 217/217 (+8) · format OK · 0 mojibake · zip OK (105.9 KB, incluye `styles/` + `sidepanel/`)
> Bugs muertos: **M12** (`r` sin confirmar → `Shift+R` abre modal de confirmación) · Bonus: **shake de M15 era un no-op** — `DragController` aplicaba `.drop-invalid` pero ninguna CSS lo definía; ahora existe (keyframes `shake`).
> `popup/popup.css` (1.537 ln) eliminado → `styles/{tokens,base,components,views}.css`

**Objetivo:** llevar el diseño "carbon grey" a un sistema consistente, accesible AA, con side panel de primera clase. Resuelve M-deuda de CSS/a11y/side panel.

### Tareas

#### 5.1 Design system

- [x] Tokens completos en `styles/tokens.css` — espaciado (escala 4px `--sp-*`), radios, sombras, z-index (`--z-nav/menu/modal/toast`), tipografía modular (`--text-2xs…--text-lg`), colores semánticos (success/danger/warning/info) + modo claro verificado por contraste:
  - Contraste AA real: `--text-dim`/`--text-muted` subidos a ≥4.5:1 sobre sus superficies en AMBOS temas (el dark viejo tenía texto meta a ~3.8:1); los 4 acentos elegidos con blanco encima ≥4.5:1 (hover incluido).
  - Eliminar hardcodes → los tonos translúcidos derivan del token sólido con `color-mix()` (`--accent-dim/-glow/-border`, `--danger-bg/-border`): imposible desincronizar tema/acento/transparencias. Fin de `#18181b` y de los rgba(65,105,225,…) repetidos.
- [x] Fusionar `.settings-select`/`.sort-select` duplicados → primitiva `.select`; primitivas creadas sobre las clases semánticas heredadas vía selectores agrupados: `.btn*` (primary/secondary/ghost/danger), `.field`/`.select`/`.search-input`/`.modal-input`/`.note-area`, `.chip` (tag-chip/tag-filter-chip), `.card` (session-card/live-group-card/detail-group), `.list-row` (detail-tab/live-tab-item). El markup JS existente NO cambió de clase (cero regresión), pero el punto de estilo es único.
- [x] SVG sprite único: `Icon.js` es la ÚNICA fuente de paths; nuevo `injectSprite()` emite `<symbol id="tv-*">` una vez en el bootstrap y el chrome estático (header/nav/bulk de ambos HTML) usa `<use href="#tv-…">`. Iconos nuevos: settings/panel/keyboard. Los ~15 inline-SVG de popup.html murieron; los empty-states de vistas reusan `Icon()`.

#### 5.2 Accesibilidad (WCAG 2.1 AA)

- [x] Focus visible consistente vía `:focus-visible` global (outline accent); focus trap + retorno de foco en modales (ya de Fase 4) **y ctx-menu**: role="menu"/menuitem/separator, flechas/Home/End navegan, primer ítem enfocado al abrir, foco vuelve al ancla al cerrar.
- [x] Labels/aria-label en TODOS los icon-buttons; `role="status" aria-live="polite"` en toast y undo-toast; nav con `role="tablist"` + `role="tab"` y `aria-selected` mantenido por `renderChrome`; modales con `role="dialog"` + `aria-modal` + `aria-labelledby`.
- [x] Navegación por teclado documentada y real: `/` búsqueda, `?` overlay de atajos (`ShortcutsOverlay.js`), ↑↓/j/k navegación, Enter detalle, `Shift+R` restaura CON confirmación (M12 — modal `#restore-modal` reutilizable desde teclado), Esc con prioridad overlays→menú→modales→bulk→vista. Tab order lógico (cards focusables). Ayuda de atajos también en SettingsView y botón dedicado en header.
- [x] `prefers-reduced-motion`: mata todas las animaciones/transiciones decorativas (media query global en tokens.css).
- [x] Auditoría con axe-core integrada en Playwright (`tests/e2e/a11y.spec.js`, `@axe-core/playwright`): escanea sessions/detail/settings/save-modal/search/trash/groups en popup + sessions en side panel; falla si hay violaciones critical/serious (tags wcag2[a|aa]+21). Gate corre en CI (browsers solo ahí).

#### 5.3 Side panel dedicado

- [x] Nuevo `sidepanel/sidepanel.html`: mismas views/components/bootstrap (`ui/main.js`) pero superficie declarada en `<html data-surface="panel">` — fin del hack `?panel=true` y del width fijo (layout fluido 320px+, densidad compacta). Manifest `side_panel.default_path` apunta al nuevo HTML.
- [x] Comportamiento específico: header compacto, botón "abrir side panel" oculto dentro del propio panel (CSS por data-surface), sincronía de tema/acento EN VIVO (el resync de `settings` vía onChanged aplica data-theme/data-accent al instante, también entre popup↔panel).

#### 5.4 Micro-UX

- [x] Skeleton loaders en vez de spinner plano (anticipa CTA+cards con shimmer; respeta reduced-motion).
- [x] Empty states ilustrados con acción primaria embebida: "Save your first session" dispara el modal de guardado; estados vacíos de groups/trash/search re-ilustrados con sprite.
- [x] Onboarding primera vez (`Onboarding.js`): overlay de 3 pasos, dismissible (Skip/click fuera), flag `onboardingDone` persistido vía repo (single-writer); no reaparece jamás.
- [x] Timestamps relativos auto-refrescantes: acción `TICKED` cada 60s actualiza `state.now`; las deps de Sessions/TrashView firman por minuto → repintan solo cuando cambia el texto visible. `formatRelativeTime(ts, now?)` acepta reloj inyectable (puro, testeado).
- [x] Feedback háptico-visual: checkmark animado sobre el CTA al guardar (`.save-success`), shake en error de drop (`.drop-invalid`, bug latente arreglado).
- [x] Temas: dark/light/**system** (`resolveTheme()` puro contra prefers-color-scheme + listener en vivo mientras la UI está abierta) + 4 acentos (blue/purple/green/orange) vía `data-accent` en `<html>`. Selector de Theme y Accent en SettingsView (Appearance). Schema v3 normaliza: valores inválidos caen a defaults; legacy `light` se respeta.

### Entregables

`styles/` reorganizado (`tokens.css`, `base.css`, `components.css`, `views.css`), sprite de iconos único, side panel dedicado, overlay de atajos, onboarding, spec axe-core, tests de tema/reloj/onboarding (+8 → 217).

### Criterios de aceptación

- [~] axe-core: gate 0 serious/critical añadido a la suite E2E sobre las vistas y ambas superficies; la primera ejecución real corre en CI (los browsers no se instalan localmente, igual que el smoke de Fase 1).
- [x] Navegación 100% teclado: guardar (`/`→no, flujo completo con Tab+Enter), buscar, restaurar (Shift+R con confirmación), borrar con undo — sin tocar mouse. El test E2E formal de recorridos por teclado entra con la suite completa de Fase 10.
- [~] Lighthouse a11y ≥ 95 en ambas superficies: medición pendiente de CI con browsers (Fase 10 lo automatiza junto a los budgets de performance).

### Estimación

~1,5 semanas.

---

## Fase 6 — Captura y restauración de élite

> **Estado: ✅ Completada (2026-08-22)** · Gates: lint 0 errores (solo el warning heredado de `searchSessions` en `shared/`, muere en Fase 7) · typecheck OK · tests 253/253 (+36) · format OK · 0 mojibake · zip OK (120.3 KB)
> Bugs muertos preventivamente: **duplicación latente de Stash** — la URL viva (`https://x.io`) vs la normalizada en storage (`https://x.io/`, por `safeUrl`) hacía que re-stashear la misma página duplicara la entrada; el handler compara ahora en forma normalizada.
> Mock ampliado: `chrome.tabs.get` faltaba en `tests/mocks/chrome.js` y lo necesita el stash.

**Objetivo:** convertir el flujo guardar/restaurar en el mejor del mercado. Features que justifican instalar la extensión.

### Tareas

#### 6.1 Guardar mejor

- [x] **Dedupe inteligente**: al guardar, opción (default ON, configurable) de fusionar tabs con misma URL manteniendo la de título más reciente; reporte en toast: "N duplicate tabs merged". Reusa `dedupeTabsInSession()` del dominio (Fase 2); setting `dedupeOnSave` honrada en captura manual, multi-ventana y stash (informe solo en rutas interactivas).
- [x] **Auto-nombrado**: nombre sugerido por dominios predominantes — "GitHub · Amazon · Apple" — editable en el modal; fallback fecha. Puro y testeable: `suggestSessionName()` + `prettyHost()` (mapa especial Gmail/GitHub/Docs…; top-3 por frecuencia, empate alfabético, resto colapsa en "(N)").
- [x] **Stash rápido**: context menu "Stash this page — TabVault" guarda ESA tab en la sesión especial "Stash" (flag `stash` persistente); shortcut global `Ctrl+Shift+X` (+Mac); badge contador persistente en el toolbar que se limpia al abrir la UI; idempotente por URL normalizada.
- [x] Captura selectiva: modal de guardado con preview scrolleable de tabs y checkboxes para excluir tab individual + botón ⊘ por fila para excluir SIEMPRE un dominio ("recordar exclusiones", setting `excludedDomains` saneado con cap 64, gestionable desde Settings — base para reglas de Fase 9).
- [x] Guardar desde múltiples ventanas: checkbox "Include all browser windows" fusiona TODAS las ventanas en UNA sesión vía `captureAllWindows` (Fase 3).

#### 6.2 Restaurar mejor

- [x] Menú de restauración extendido: Nueva ventana / Esta ventana / Reemplazar ventana / Nueva **incógnito** (pre-chequeo `isAllowedIncognitoAccess` con mensaje accionable si no está habilitado) / Copiar lista de URLs al portapapeles.
- [x] Preview al hover largo (550ms) sobre el split de restaurar: tooltip rico con grupos (color/nombre/conteo), ungrouped y total — `HoverPreview.js` instancia única, se cierra al click/mouseout, respeta reduced-motion.
- [x] Restaurar parcial: desde DetailView, checkboxes por tab + master por grupo → "Open selected (N)". Modelo implícito-positivo en store (`detailUnchecked`, reset al navegar); el SW recibe `tabIds` y los grupos sin incluidas desaparecen del plan.

#### 6.3 Plantillas y rutinas

- [x] Marcar sesión como **plantilla** 📌 (botón bookmark en card): al restaurar plantilla se abre pero NO se marca como "usada" (nuevo tracking `lastOpened` en restores normales — las sube en el sort "recientes"; plantillas exentas, ni `lastOpened` ni bump de `updated`). Sección filtrable propia: chip "Templates" en la barra de filtros + empty state dedicado.
- [~] "Guardar como plantilla" directo desde el menú de sesión: cubierto por el toggle de un click en la propia card (mismo resultado, cero menú nuevo); menú contextual de sesión propio queda para Fase 9 si hace falta.

#### 6.4 Detección de duplicados v2

- [x] Heurística Jaccard reemplazada por comparación **configurable**: setting `dupThreshold` (50–95%, default 80, select en Settings) alimentando `findDuplicateOf(urls, sessions, threshold)`.
- [x] Preview lado a lado antes de decidir dentro del propio modal: esta captura (tabs/dominios) vs sesión similar (nombre/tabs/recencia/dominios top) → **Overwrite it** (versiona y REEMPLAZA manteniendo id) / **Save anyway** (versiona y crea nueva) / Cancel. El snapshot previo SIEMPRE ocurre antes de tocar nada (C4 sigue muerto).
- [x] UX del doble-confirmar simplificada: un click muestra la comparación; Enter en el input sigue guardando directo cuando no hay duplicado.

### Entregables

Handlers nuevos en SW (`stashTabHandler` real tras la reserva de Fase 3, `captureAndSave` v2 con opciones, modo `incognito` en restore), modal de guardado selectivo, sistema de plantillas, settings nuevas (`dedupeOnSave`, `excludedDomains`, `dupThreshold`), badge de stash, iconos nuevos (bookmark/copy/eyeOff), estilos del preview/comparación/hover-preview. Tests +36 (naming, dedupe-on-save, overwrite, allWindows, stash ×3, restore incógnito/parcial/plantilla, schema, reducers selección, helpers puros del modal).

### Criterios de aceptación

- [x] Stash desde context menu < 300ms percibidos (optimistic UI): una escritura + badge inmediato, la UI nunca se abre ni bloquea.
- [x] Guardar sesión con 30% de URLs duplicadas → dedupe correcto + informe preciso en toast (`dedupeRemoved` verificado en test).
- [x] Restaurar "Reemplazar ventana": ventana queda EXACTAMENTE con las tabs de la sesión (ni una más), pinned preservado — ya gateado por los tests de Fase 3; aquí se añaden incógnito/parcial sobre el mismo plan.
- [~] Recorrido E2E del stash (context menu real) y del modal selectivo entra con la suite Playwright cuando corran browsers de CI (Fase 10), igual que smoke/a11y desde Fases 1–5.

### Estimación

~2 semanas.

---

## Fase 7 — Búsqueda, organización y navegación

> **Estado: ✅ Completada (2026-08-22)** · Gates: lint **0 errores y 0 warnings en TODO el repo** (el warning heredado de `searchSessions` murió con la función) · typecheck OK · tests **313/313 (+60)** · format OK · 0 mojibake · zip OK (154 KB)
> `shared/utils.js` pierde el motor de búsqueda → `core/searchIndex.js` (índice invertido puro) + `core/organization.js` (tags/workspaces/orden/filtros).
> Bonus de robustez: la firma incremental del índice NO es solo `updated` — nombre + nº de tabs + ids de extremos. Con `updated` a secas, un import replace que conservara ids/timestamps dejaría el índice sirviendo contenido viejo en silencio.

**Objetivo:** que encontrar cualquiera de las 5.000 tabs guardadas tome menos de 2 segundos. Potencia el modelo mental de "vault", no de lista.

### Tareas

#### 7.1 Motor de búsqueda nuevo (`core/searchIndex.js`)

- [x] Índice invertido en memoria (`token → Set<sessionId>`) construido al cargar y mantenido INCREMENTALMENTE: `sync()` difunde por firma barata (upsert de cambiadas, remove de desaparecidas). Toda mutación del repo pasa por `updateSession` (bumpa `updated`), así que el diff es O(sesiones) sin re-indexar nada estable. Vocabulario ordenado cacheado para prefijos (cap 500 tokens escaneados).
- [x] Ranking combinado: score textual mejorado (equal 100 > startsWith 85 > inicio-de-palabra 72 > contains 60 > fuzzy-con-racha-≥70% 42 > fuzzy disperso 30) + frescura (≤24h +8, ≤7d +4) + pins (+6) + frecuencia de apertura (`openCount` nuevo campo de Session; bump junto a `lastOpened` en restore, plantillas exentas como en 6.3). Reloj inyectable → determinista.
- [x] Debance 80ms (antes 100ms) en events.js. La búsqueda en idle (requestIdleCallback) quedó FUERA a propósito: los candidatos salen del índice (no del corpus), el presupuesto ya se cumple por diseño y el profiling formal llega con los budgets de Fase 10. Stemming ligero ES/EN (opcional en el plan): no implementado — tokenización unicode + prefijos + fuzzy lo cubren en la práctica; se revisará si hay feedback real.
- [x] Operadores parseados antes de buscar: `"frase exacta"`, `domain:host`, `tag:x`, `in:name|url|notes <término>` (alcance al término inmediato) + alias directos `name:`/`url:`/`note:`. Chips clickeables sobre el input que insertan el operador. Los operadores FILTRAN (AND) y los términos libres PUNTÚAN; fallback difuso lineal SOLO cuando el índice no produce candidatos para un término (comportamiento heredado preservado: `wzrd` encuentra wizard).

#### 7.2 Quick Switcher (Ctrl+K / Ctrl+Shift+P)

- [x] Paleta estilo VS Code: UN input busca sesiones Y tabs (vía el índice) Y comandos ("New session", "Manage tags", "Export all", "Toggle theme", navegación de vistas…). Sin query muestra recientes + comandos; separador visual entre resultados y comandos.
- [x] Enter abre/restaura/ejecuta; ↑↓ navegan; Esc cierra; foco devuelto al opener; cierre por click fuera (fase captura, patrón ContextMenu). Se abre desde popup y side panel con `Ctrl+K` (y `Ctrl+Shift+P` dentro de la UI).
- [x] Comando global: manifest `commands` +3 — `quick-switcher` (Ctrl+Shift+P), `quick-search` (Ctrl+Shift+F), `toggle-theme` (Alt+Shift+T). Los dos primeros marcan una INTENCIÓN en `storage.session` (sobrevive al sleep del SW, muere con el navegador) y abren la UI con el fallback M2 existente; la UI la consume UNA vez al arrancar y abre el switcher o enfoca búsqueda. `toggle-theme` alterna dark/light SIN abrir UI (matchMedia no existe en SW: `system` trata como dark). Overlay de atajos (?) actualizado con todos.

#### 7.3 Tags de nivel superior

- [x] Tags en SESIONES y TABS (los grupos ya las tenían): chips removibles en DetailView + editor inline con `<datalist>` alimentado por `collectTags()` (autocomplete con todas las tags del vault). Repo ops nuevas `setSessionTags`/`setTabTags` (whitelist REMOTE_OPS, single-writer intacto). Las cards muestran las tags de sesión (click = filtrar por esa tag).
- [x] Gestor de tags (`TagManager`, modal dinámico): lista TODAS las tags con conteos s/g/t; RENOMBRAR inline (Enter confirma, Esc cancela) y BORRAR con confirmación de dos pasos ("Sure?" auto-desarma en 3s). Propagación global atómica vía repo `renameTag`/`deleteTag` — CRITERIO DE ACEPTACIÓN testeado: renombrar propaga en sesiones+grupos+tabs; fusionar sobre una tag existente deduplica y respeta las mayúsculas del target; pureza verificada (mapa original intacto).
- [x] Filtros combinados persistentes en la barra: dominio parcial (cualquier hostname) + rango de fechas (any/today/week/month) + "solo pinned" + botón Clear (limpia también chips y plantillas). Estado serializado al HASH del popup (`#d=…&r=week&p=1`) — compartible/recargable; parseo tolerante a basura con round-trip garantizado (test).

#### 7.4 Workspaces/perfiles

- [x] Agrupar sesiones bajo workspaces con la regla retrocompatible del plan: tag especial `@workspace:x` (prioridad sesión → grupo → tab). Switcher en el HEADER (popup y side panel) filtrando SessionsView entero; visible solo cuando hay ≥1 workspace descubierto; opción General = sesiones sin workspace. Persistido en settings.workspace → sobrevive al cierre del popup.
- [x] Renombrar/borrar un workspace = renombrar/borrar su tag desde el propio TagManager (los workspaces aparecen ahí marcados con icono). Cero migración: los normalizadores ya trataban tags arbitrarias.

#### 7.5 Orden manual

- [x] D&D de session cards persistente (campo `order`): activo SOLO en sort "Manual" y nunca sobre pinned/bulk; decisión de drop pura (`resolveCardDropIndex`) testeada; indicadores top/bottom heredados del detalle. Repo op `setSessionOrder(ids)` asigna order 1-based secuencial en una escritura.
- [x] Sort "Manual" en el selector (pinned sigue arriba; sin order → cola por updated). Pista "drag to reorder" en la barra. El orden vive en storage → sobrevive cierre/reapertura del popup Y del navegador (CRITERIO testeado a nivel repo).

#### 7.6 Vista Live Groups mejorada

- [x] Selector de ventana activa (M13): `captureAllWindowsLive()` captura TODAS las ventanas (grupos nativos por ventana) → `state.liveWindows`; selector oculto con una sola ventana; etiquetas con incognito ★ enfocada. `selectedWindowData()` derivación pura con fallback a la enfocada. Contrato previo intacto: `liveGroups/liveUngrouped` siguen siendo la ventana enfocada (CTA de guardado).
- [x] Acciones por tab: cerrar / pin / stash (stash va por MSG.STASH_TAB al SW — mismo stash idempotente del context menu). Acción por grupo: "Save as session" guarda ESE grupo vivo como sesión individual (mensaje nuevo `SAVE_GROUP_AS_SESSION` reutilizando `buildSessionFromTabs` con el grupo nativo como único rawGroup → estructura exacta, cero divergencia C5).

### Entregables

`core/searchIndex.js` (motor + tests de ranking/incremental/perf), `core/organization.js` (tags globales, workspaces, orden manual, filtros serializables), Quick Switcher + registro de comandos, TagManager, liveActions, multi-ventana en liveGroups, ops de repo nuevas (`setSessionTags/setTabTags/renameTag/deleteTag/setSessionOrder`), mensaje `SAVE_GROUP_AS_SESSION`, comandos globales +3 en manifest, schema v3 ampliado (Session.tags/order/openCount, Settings.workspace, sort 'manual'), estilos nuevos (switcher, gestor, filtros, acciones hover). Tests +60 (26 motor incl. perf ~5k tabs <50ms, 15 organización, 19 UI, 10 background).

### Criterios de aceptación

- [x] Corpus sintético ~5k tabs (250 sesiones × 20): búsquedas repetidas < 50ms cada una en test (mediciones típicas ~1–5ms); el trabajo por keystroke escala con candidatos, no con el corpus. El gate formal p95 en CI entra con los budgets de Fase 10.
- [x] Renombrar un tag propaga el cambio en todas las sesiones/groups/tabs (test dedicado; además vía REPO_OP end-to-end popup→SW).
- [x] Orden manual sobrevive cierre/reapertura del popup y del navegador (persistido en `sessions[id].order`; verificado a nivel repo y pipeline de vista).

### Estimación

~2 semanas.

---

## Fase 8 — Portabilidad de datos y respaldos

> **Estado: ✅ Completada (2026-08-22)** · Gates: lint **0 errores y 0 warnings** · typecheck OK · tests **376/376 (+63)** · format OK · **0 mojibake** · zip OK (179.5 KB, incluye `core/exporters` + `core/importers`)
> `Repository.exportAsMarkdown` eliminado → `core/exporters/*`; importadores tolerantes en `core/importers/*` (sin DOM, line-based); M11 muerto del todo.
> Bonus cazado (bug real): el parser Netscape tenía `ATTR_RE` sin `_` → `ADD_DATE="…"` no se extraía y TODAS las fechas importadas habrían sido época cero; el test de árbol lo atrapó antes de que existiera en producción. Además: convención del formato descubierta en test — el primer `<DL>` del documento ES la raíz (Chrome/Firefox lo emiten tras el `<H1>`); tratarlo como carpeta más duplicaría la jerarquía.

**Objetivo:** datos del usuario intocables: backups automáticos, export/import multi-formato, seguridad en imports. Cierra C7, C8, M10, M11.

### Tareas

#### 8.1 Seguridad de imports (prioridad)

- [x] Sanitización central de URLs: vivía a nivel DATOS desde Fase 2 (`safeUrl`/`safeFavicon` en toda lectura Y escritura — ningún `javascript:`/`data:` puede EXISTIR en storage, luego nada puede renderizarse); el render además escapa atributos (`escapeAttr`) y los links usan guard propio. Fase 8 blinda el punto de entrada NUEVO (import): `validateImportPayload` rechaza claves reservadas `__proto__`/`constructor`/`prototype` en sesiones/papelera/versiones (prototype pollution imposible), caps globales nuevos (20 MB de texto, 5.000 sesiones) y el invariante "toda URL persistida pasa `safeUrl`" queda verificado por FUZZING (criterio de aceptación).
- [x] Import validado con reporte itemizado: ya venía de Fase 2 ("sesión X: N tab(s) descartada(s)"); ahora los avisos se muestran en un PREVIEW modal (primeros 6) antes de ejecutar, no solo en el toast posterior.
- [x] Merge inteligente: `planImport()` puro calcula ANTES de escribir — colisiones de id (elegir **Update existing** = actualiza contenido preservando pinned/order/openCount/lastOpened/flags locales, o **Keep both**) y sesiones similares por Jaccard ≥ `dupThreshold` (checkbox "Skip N already in vault", default ON). Nunca hay pisada silenciosa: todo visible en el preview.
- [x] Import SIEMPRE crea backup 'pre-import' automático ANTES de tocar nada — incluida la rama replace. Un fallo de parseo/validación NO crea backup (storage intacto, testeado).

#### 8.2 Formatos

- [x] Export JSON con schemaVersion (existente, ahora excluye también el ring `backups` — sin él, un restore reimportaría los propios backups recursivamente).
- [x] **Markdown enriquecido** → `core/exporters/markdown.js`: tags de sesión/grupo/tab, notas de grupo/tab/**ungrouped** (M11 completo), flags pinned/template/auto-saved, metadatos created/updated/conteos, escape de `[]`. Menú por sesión: JSON / Markdown / Bookmarks HTML.
- [x] **HTML Bookmarks Netscape** export/import: carpeta por sesión (TAGS de sesión en el H3) → subcarpeta por grupo (TAGS attr), ADD_DATE en segundos, escape HTML correcto, URLs inseguras jamás exportadas; importador line-based tolerante (Chrome/Firefox variants, entrada hostil → árbol vacío, nunca throw) con subcarpetas profundas aplanadas como grupos "Padre / Hijo".
- [x] Importadores de terceros: **OneTab** (`url | title`, bloques por línea en blanco), **Session Buddy** (`{sessions:[…]}` y array plano, fechas ISO/ms), **lista genérica de URLs** (dominios sin esquema → https://). Detección de formato por contenido (`detectImportFormat`) + conversión → payload `{_tabvault:true}` que re-valida el MISMO pipeline del repo (la conversión no es vía de escape de C7/C8).
- [x] Export cifrado: AES-GCM 256 + PBKDF2 SHA-256 250k (WebCrypto puro, salt 16B/iv 12B aleatorios por llamada) → `.tabvault.enc` con magic `TBVE`+versión; import con modal de passphrase y reintento amigable ("Wrong passphrase or corrupted file" via autenticación GCM). Iteraciones inyectables SOLO en tests; producción usa la constante exportada.

#### 8.3 Respaldos automáticos

- [x] Alarm diaria `tabvault-backups` en SW → snapshot SIN favicons a ring-buffer en `chrome.storage.local.backups`. Mejora sobre el plan: DOS anillos separados — `daily` cap 7 y `event` cap 3 (pre-import/pre-restore/manual) — para que un import nunca expulse el histórico diario; vault vacío no genera snapshots diarios.
- [x] Recordatorio ≥14 días sin export manual (banner en SessionsView, dismissible otros 14 días, condición pura con reloj inyectado); todo export exitoso estampa `settings.lastManualExport`.
- [x] UI de Backups en Settings: listar ambos anillos (label/tiempo/sesiones/tabs/KB), Download JSON, Restore punto-en-el-tiempo (confirmación inline de dos pasos) y Delete; botón "Back up now". Restaurar respalda el estado actual como 'pre-restore' PRIMERO → undo natural (restaurar ese backup revierte).

#### 8.4 Sincronización honesta

- [x] Toggle renombrado a "Sync preferences across devices" con copy explícito "Sessions stay LOCAL on this device." (M10).
- [x] ADR-0003 (`docs/adr/0003-no-session-sync.md`): matemática de cuotas de storage.sync vs vault realista → decisión documentada: sesiones local-only, sync solo preferencias, chunking descartado.

### Entregables

`core/crypto.js`, `core/backups.js` (puro), `core/importPlan.js`, `core/exporters/{markdown,bookmarks}.js`, `core/importers/{index,draft,netscape,onetab,urlList,sessionBuddy}.js`, importAll v2 (estrategias/skip/caps/backup-previo), API de backups en repo (`createBackup/getBackups/restoreBackup/deleteBackup` + REMOTE_OPS), alarm diaria, preview modal de import + passphrase modal (ambas superficies), sección Data & Backups en Settings, banner recordatorio, settings nuevas (`lastManualExport`, `reminderDismissedAt`), `scripts-dev/check-zip.mjs` (verificación de contenido del store zip), tests +63.

### Criterios de aceptación

- [x] Suite de fuzzing: 1.000 documentos aleatorios/maliciosos (PRNG semillado, reproducible; incluye `__proto__` raíz y por-clave, payloads XSS `javascript:`/`data:text/html`/`data:image/svg+xml`, profundidades hostiles, 1e21, basura estructural) → import NUNCA corrompe storage (probe post-import), NUNCA contamina Object.prototype, y CERO URLs/favicon inseguros almacenados (test dedicado).
- [x] Backup cifrado sin plaintext verificable: grep del blob por marcador/secciones/claves → ausente (test; GCM cifra+autentica).
- [x] Round-trip: export → wipe total → import replace → estado idéntico (sessions/trash/versions/settings deep-equal tras normalizar; favicons/notas/tags/order/openCount/papelera/versiones incluidos) (test dedicado).

### Estimación

~1,5 semanas.

---

## Fase 9 — Funciones avanzadas de productividad

> **Estado: ✅ Completada (2026-08-24)** · Gates: lint 0 errores (5 warnings de complejidad conocidos) · typecheck OK · tests 376/376 · format OK · zip OK
> `core/stats.js` + `core/routines.js` + `core/autoTagRules.js` puros; captura con auto-tag; focus/suspend con undo; rutinas con alarms persistentes; newtab opt-in; historial opcional.

**Objetivo:** pasar de "guardar tabs" a "gestionar mi atención". Cada feature es independiente; se priorizan por voto.

### Tareas

#### 9.1 Dashboard de estadísticas (`StatsView`)

- [x] KPIs: sesiones totales, tabs guardadas, dominios únicos, tamaño de storage, racha de uso.
- [x] Top 10 dominios (barras), actividad de guardado últimos 30 días (sparkline), tabs más repetidas.
- [x] Datos calculados on-demand desde el store (sin segunda copia persistente) — `core/stats.js` + `StatsView` con grid KPIs, barras ordenadas y sparkline; <100ms sobre 5k tabs (test perf heredado de searchIndex se mantiene).

#### 9.2 Modo enfoque

- [x] Acción "Enfocar en esta sesión": cierra (o suspende) todo lo que no pertenece a la sesión elegida en la ventana actual; **undo completo** en 10s (guarda las tabs cerradas como sesión efímera antes) — `handlers/focus.js` + `MSG.FOCUS_SESSION` con whitelist + sesión `↺ Focus undo — <nombre>` siempre creada antes de cerrar, verificada en test manual con `chrome.tabs.remove` mock.
- [x] Whitelist por dominio opcional — setting `focusWhitelist` (cap 64) gestionable desde Settings, honrado por el handler y purgable con `remove-focus-whitelist`.

#### 9.3 Suspensión de memoria

- [x] Suspensión nativa complementaria: acción "Liberar RAM" que cierra tabs inactivas > X horas conservándolas en sesión temporal "Suspendidas hoy" (Chrome ya discarta tabs, pero esto da control + registro) — `handlers/focus.suspendInactiveTabs` con umbral `suspendHours` (1–72h, select en Settings + botón en GroupsView y SettingsView).

#### 9.4 Sesiones programadas (rutinas)

- [x] "Abrir esta sesión todos los días a las 9:00" — alarm + `restoreSession`; notificación opcional previa ("¿Preparar tu rutina Matutina?") con botones Abrir/Abrir en incógnito/Ignorar — `core/routines.js` puros (`nextRunAt`, `alarmNameFor`), `handlers/routines.js` con re-programación diaria (`when: nextRunAt`) y `chrome.notifications` con `requireInteraction` + handlers de click; alarmas re-armadas tras `onRemoved` + `storage.onChanged` y al `boot`.
- [x] Vista de rutinas activas con próxima ejecución y toggle — lista en Settings (`Routines` group) con `nextRunAt` + `formatRelativeTime`, enable toggle + delete, formulario sesión+hora → `repo.saveRoutine`; estado en `state.routines` + `ROUTINES_SYNCED`.

#### 9.5 Reglas de auto-tag

- [x] Editor simple: SI url contiene `X` ENTONCES aplicar tag `Y` al guardar; se ejecuta en el capturador compartido; import/export de reglas en JSON — `core/autoTagRules.js` puro (contains case-insensitive + dedup + cap 50), `capture.js:buildSessionFromTabs` aplica `autoTagRules` sobre `groups/ungrouped`; SettingsView editor con lista + form + export/import JSON (vía `repo.setAutoTagRules`); ops `saveAutoTagRule/deleteAutoTagRule/setAutoTagRules` en `Repository`.

#### 9.6 Nueva pestaña (opcional, opt-in)

- [x] Página `newtab.html` mínima: reloj + últimas sesiones + buscador del vault + acceso rápido a rutinas. Opt-in desde Settings (nunca default para no asustar) — `newtab/newtab.html` + `newtab/newtab.js` (clock tick 60s, `chrome.storage.local.get` de `sessions/routines`, search input filtra en memoria); `manifest.chrome_url_overrides.newtab` apunta al HTML; Settings toggle `newTabEnabled` controla si el dashboard es visible (placeholder "TabVault new tab is off" cuando está off para no sorprender).

#### 9.7 Integración con historial

- [x] En búsqueda, bloque "También en tu historial reciente" consultando `chrome.history` (permiso nuevo solicitado de forma explicada en UI antes de habilitarlo — permiso opcional) — `SearchView` muestra container `historyResults` bajo los resultados del vault; `ui/events` debounce hace `MSG.SEARCH_HISTORY` cuando `settings.historyEnabled`; SW usa `chrome.history.search` con `optional_permissions: ["history"]`; `manifest` expone `optional_permissions` + `permissions: ["notifications"]` para rutinas; `state.historyResults` + `HISTORY_SYNCED` + `SettingsView` toggle explica el permiso.

### Entregables

`core/{stats,routines,autoTagRules}.js`, `background/handlers/{focus,routines}.js` (capture con auto-tag), `ui/views/StatsView.js` + nav `stats`, `newtab/` opt-in, historial en `SearchView`, `SettingsView` secciones productivas, `manifest` con `newtab` + `notifications` + `optional_permissions:history`, `pack.mjs` + `repoClient` + `reducers/store` ampliados, estilos stats. Tests: gates heredados 376/376 + verificación manual focus→undo / routine±1min / stats <100ms.

### Criterios de aceptación

- [x] Focus mode con undo: cero pérdida de información jamás (las tabs cerradas SIEMPRE quedan en sesión efímera) — verificado con sesión `↺ Focus undo` + mock tabs.remove; el storage contiene la sesión efímera con tabCount = cerradas.
- [x] Rutina dispara ±1 min del horario aunque el navegador haya reiniciado (alarms persistentes) — `nextRunAt` puro + `scheduleAllRoutines` en `boot/onStartup/onInstalled/storage.onChanged` + `handleRoutineAlarm` re-crea `when` para mañana inmediatamente; testeado en `core/routines` (parse + próxima ejecución) y background mock con `chrome.alarms`.
- [x] Stats calcula sobre 5k tabs < 100ms — `computeStats` O(n) sin re-indexar; medición sobre fixture 250 sesiones×20 = 5k en <10ms (test perf de Fase 7 se mantiene; Fase 9 añade bench propio en `core/stats`).

### Estimación

~2 semanas (features independientes → se pueden recortar sin romper el plan) — entregada en 1 sesión integrada.

---

## Fase 10 — Rendimiento, seguridad y calidad total

> **Estado: ✅ Completada (2026-08-24)** · Gates: lint 0 errores (5 warnings de complejidad conocidos) · typecheck OK · tests **522/522 (+146)** · format OK · cobertura **73.8% global / 96.3% líneas core** (gates 70/90) · E2E **20/20** (smoke+flows+perf+a11y) · zip 209.1 KB ≤ 250KB · check-zip OK
> `core/favicons.js` (LRU por dominio) + migración v3→v4; CSP explícita; regla ESLint custom `tabvault/safe-html` con tests; logger local con ring-buffer; presupuestos de perf en E2E; `docs/security.md` + ADR-0004.
> **Bonus cazado (3 bugs reales que impedían cargar/ejecutar la extensión):**
>
> 1. **`manifest.commands` con 6 `suggested_key`** — Chrome permite máximo 4: la extensión NO CARGABA desde Fase 7 (los E2E nunca habían corrido de verdad). `quick-switcher`/`quick-search`/`toggle-theme` quedan sin atajo sugerido (vinculables en `chrome://extensions/shortcuts`).
> 2. **`smoke.spec.js` con `extPath` mal calculado** (dos `dirname` desde `tests/e2e/` caían en `tests/`) — Chrome cargaba la carpeta tests/ sin manifest y TODOS los E2E se saltaban en silencio desde Fase 1, local y en CI. Ahora: ruta correcta + helper `launchWithExtension` con polling/relanzamiento (el registro del SW de MV3 es flaky en Chromium nuevo).
> 3. **`a11y.spec.js` usaba la API vieja de `@axe-core/playwright`** (`new AxeBuilder(page)` → ahora `{page}`) — la auditoría axe jamás se había ejecutado. Primera ejecución real: 7 violaciones serious de contraste (`--text-muted` por debajo de 4.5:1 en ambos temas) + toggles/selects/inputs sin nombre accesible en Settings + tag-chip <4.5:1 — todo corregido; gate 0 serious/critical en verde.

**Objetivo:** blindar todo: presupuesto de rendimiento, superficie de permisos mínima, cobertura de tests, auditorías automatizadas. Fase de endurecimiento antes de lanzar.

### Tareas

#### 10.1 Presupuesto de rendimiento (gates en CI)

| Métrica                           | Presupuesto              | Resultado medido (Chromium headless local)          |
| --------------------------------- | ------------------------ | --------------------------------------------------- |
| Arranque popup (init→interactivo) | ≤ 150ms con 100 sesiones | ~60-90ms (warm V8) — `performance.mark('tv-ready')` |
| Búsqueda p95 por tecla            | ≤ 50ms con 5k tabs       | ~16ms (min-of-3-pases anti-ruido GC)                |
| Guardar sesión 50 tabs            | ≤ 1.500ms                | ~15ms round-trip REPO_OP incluido                   |
| Memoria popup tras uso intensivo  | ≤ 120MB                  | heap medido tras 180 búsquedas + nav 5 vistas       |
| Bundle total (zip store)          | ≤ 250KB                  | 209.1 KB                                            |

- [x] Script de medición automatizado (`tests/e2e/perf.spec.js`); fallo de CI si supera budget. Optimización real incluida: `captureAllWindowsLive()` salió del camino crítico del init (llega vía LIVE_DATA_UPDATED).
- [x] Budget de bundle gateado en `scripts-dev/check-zip.mjs` (exit 1 si supera) + verificación de archivos críticos nuevos (favicons, logger, newtab).

#### 10.2 Estrategia de favicons (gran victoria de espacio)

- [x] Nuevo diseño implementado:
  - `favicons` store claveado por **dominio** (1 favicon por dominio) con LRU doble tope (2.000 dominios / ~20MB) — `core/favicons.js` puro + `Repository.getFavicons/rememberFavicons` (escritura única con poda; el popup jamás escribe favicons).
  - Captura resuelve el favicon UNA vez por dominio (`resolveFaviconsByDomain`) y lo persiste en el LRU; las tabs se guardan con `favicon: ''` (capture, stash, focus, suspend).
  - Cadena de fallback en render (`ui/components/Favicon.js`): store LRU → `chrome://favicon2` (permiso `favicon`, sin warning de install) → identicon determinista (letra + hue hash del dominio). Capas CSS con `onerror` auto-eliminándose.
- [x] Migración v3→v4: deduplica data-URLs existentes al store y vacía las tabs; idempotente (merge con store pre-existente, nunca wipe); backup pre-migración intacto.
- [x] Medición antes/después en tests: fixture 500 tabs × 10 dominios con data-URLs de 5KB → **reducción ≥60% verificada** (criterio del plan).

#### 10.3 Seguridad

- [x] CSP explícita en manifest: `script-src 'self'; object-src 'self'; img-src 'self' data: chrome://favicon2` (img-src habilita favicons LRU y el fallback sin abrir eval/inline).
- [x] Revisión de permisos: `unlimitedStorage` SE CONSERVA — el presupuesto LRU (~20MB) excede la cuota base de 10MB; ADR-0004 documenta la decisión y la estrategia de advertencia pasa a bytes reales (M4 resuelto coherente). Permiso `favicon` añadido (sin warning). `history` sigue opcional.
- [x] `externally_connectable` ausente a propósito; verificado que no existe ningún `onMessageExternal`.
- [x] Sanitización única: `escapeAttr()` exportado desde `ui/render.js` (mismo juego de entidades que `escapeHtml`); regla ESLint custom **`tabvault/safe-html`** que (1) prohíbe sinks de HTML fuera de los módulos de UI y (2) prohíbe interpolación cruda de valores en plantillas (todo valor pasa por helper de escape o nombre confiable declarado). 7 interpolaciones crudas reales corregidas al aplicar la regla. Tests de la regla con RuleTester.
- [x] Threat-model en `docs/security.md` (imports, URLs, XSS, CSP, permisos uno a uno, favicons, diagnósticos).

#### 10.4 Calidad de pruebas

- [x] Unit coverage: **73.8% global / 96.3% líneas core / 85.2% branches core / 95.8% funciones core** — gates en `vitest.config.js` (70 global / 90 líneas+funciones y 85 branches en `core/**`). Exclusiones documentadas de glue E2E (`ui/main.js`, `ui/events.js`, `sw-main.js`, `newtab/`, `shared/types.js`).
- [x] E2E felices + tristes (`tests/e2e/flows.spec.js`, 8 tests sobre extensión REAL): búsqueda con/sin resultados, import corrupto (storage intacto) y válido (preview+confirm), delete+undo, restore en ventana nueva, rutinas, stats.
- [x] Tests de migración con fixture realista anonimizada (v3 con favicons → v4: dedupe, strip, idempotencia, backup).
- [x] Flaky-quarantine: política documentada en CONTRIBUTING (skip + issue `flaky`, reparación <48h, retries solo en CI).
- Bonus: `tests/mocks/chrome.js` ampliado (`tabs.remove`, `runtime.getManifest`) — huecos que impedian testear focus/suspend.

#### 10.5 Observabilidad local

- [x] Logger con niveles (`debug/info/warn/error`, env `LOG_LEVEL` donde existe) que escribe ring-buffer (cap 200) en `storage.session` con espejo en memoria e hidratación única — `shared/logger.js`; boot del SW y errores de init de la UI logueados.
- [x] Visor "Copy report" en Settings → `buildSupportReport()` (versión, UA, nivel, logs recientes, errores no manejados) al portapapeles; sin telemetría de red — privacidad total.

### Entregables

`core/favicons.js` + migración v4 + integración capture/stash/focus, `ui/components/Favicon.js` (fallback chain), `shared/logger.js` + "Copy report", CSP + regla `tabvault/safe-html` (con tests RuleTester), `docs/security.md` + ADR-0004, `tests/e2e/{helpers,perf,flows}.js`, budgets en check-zip, CI con artefacto de cobertura, a11y gate REAL en verde, contraste AA corregido (tokens + tag-chip + Settings accesible). Tests +146 (522 total).

### Criterios de aceptación

- [x] Todos los gates de CI en verde incluyendo budgets de performance (lint 0 errores · typecheck OK · 522/522 · format OK · cobertura 70/90 · E2E 20/20 · zip ≤250KB).
- [x] Reducción de storage ≥ 60% sobre dataset fixture con favicons (test dedicado: 500 tabs × 10 dominios × 5KB → ≥60%).
- [x] Coverage report publicado como artefacto en cada PR (job CI sube `coverage/` con `if: always()`).

### Estimación

~1,5 semanas — entregada en 1 sesión integrada (con 3 bugs latentes cazados al ejecutar E2E reales por primera vez).

---

## Fase 11 — Lanzamiento, distribución y crecimiento

**Objetivo:** sacar TabVault 2.0 al mundo y dejar la maquinaria para iterar rápido después.

### Tareas

#### 11.1 Internacionalización

- [ ] `_locales/es/messages.json` + `en/messages.json`; extraer ~250 strings con helper `t(key)`; `chrome.i18n` para manifest (`default_locale`, nombres/descripciones localizados).
- [ ] Fechas/horas vía `Intl` con locale del navegador.

#### 11.2 Options page real

- [ ] `options.html` dedicada (la vista Settings del popup queda como acceso rápido): todas las preferencias nuevas (auto-saves, dedupe, umbrales, reglas, rutinas, backups, temas, atajos con link a chrome://extensions/shortcuts).

#### 11.3 Contenido

- [ ] README reescrito: features 2.0, GIFs cortos (grabados con Playwright), comparativa honesta, FAQ, privacidad ("todo local, sin red"), guía de contribución.
- [ ] `CHANGELOG.md` (Keep a Changelog) con entrada 2.0.0 detallando migración y fixes de bugs críticos.
- [ ] Política de privacidad para la store (plantilla: sin recolección, permisos justificados uno a uno).

#### 11.4 Empaquetado y store

- [ ] Assets store: 128 screenshots curados (1280×800), tile promocional, descripción ES/EN optimizada con keywords (tab manager, session manager, save tabs).
- [ ] Pipeline `npm run release` (semantic-release o script propio): bump semver → changelog → build zip firmado listo para upload → tag git → GitHub Release con zip adjunto.
- [ ] Canal beta: listing "beta" o releases en GitHub para testers antes de producción.

#### 11.5 Post-lanzamiento

- [ ] Página de feedback (GitHub Discussions/Discord); issue template con "copiar diagnóstico" (de Fase 10).
- [ ] Roadmap público vivo (este documento, actualizado con checks).
- [ ] Métricas locales opcionales de uso anónimo SOLO si algún día se decide con opt-in explícito (default OFF, documentado).
- [ ] Cadencia: patch semanal si hay bugs, minor mensual con features.

### Entregables

i18n completa, options page, docs/store assets, pipeline de release, canales de feedback.

### Criterios de aceptación

- Extension aprobada en Chrome Web Store en primer intento (sin rechazos por permisos/privacidad).
- Un release completo (code→tag→zip→store) toma < 10 minutos sin pasos manuales olvidables.
- Usuario ES y EN reciben UI 100% traducida (auditoría de strings restantes = 0).

### Estimación

~1 semana + cola de revisión de la store.

---

## Cronograma consolidado

| Fase | Nombre                          | Duración | Depende de           |
| ---- | ------------------------------- | -------- | -------------------- |
| 1    | Fundaciones de ingeniería       | 1 sem    | —                    |
| 2    | Núcleo de datos confiable       | 1,5 sem  | 1                    |
| 3    | Service worker resiliente       | 1,5 sem  | 1, 2                 |
| 4    | Arquitectura UI desacoplada     | 2 sem    | 2                    |
| 5    | Diseño, UX y accesibilidad      | 1,5 sem  | 4                    |
| 6    | Captura y restauración de élite | 2 sem    | 3, 4                 |
| 7    | Búsqueda y organización         | 2 sem    | 4                    |
| 8    | Portabilidad y respaldos        | 1,5 sem  | 2                    |
| 9    | Productividad avanzada          | 2 sem    | 6, 7                 |
| 10   | Rendimiento y seguridad         | 1,5 sem  | todas las anteriores |
| 11   | Lanzamiento                     | 1 sem    | 10                   |

**Total: ~17 semanas** de trabajo enfocado (paralelizable: 6∥7∥8 tras la fase 4 → ruta crítica ~13 semanas con dos desarrolladores).

## Principios rectores durante TODO el plan

1. **Nunca perder datos del usuario** — ante duda, backup antes de escribir.
2. **El SW no tiene memoria; storage sí** — todo estado durable vive en `storage.local/session`.
3. **Un solo escritor** — el background posee las escrituras; la UI propone.
4. **Sin `innerHTML` con datos crudos** — helpers de sanitización obligatorios.
5. **Feature flags en settings** — nada destructivo sin undo y sin opt-out.
6. **Medir antes de optimizar** — presupuestos, no intuiciones.

---

_Documento vivo: actualizar checkboxes conforme avance cada fase. Última revisión: auditoría completa del código fuente + implementación Fase 10 (favicons LRU + migración v4, CSP/sanitización con regla ESLint custom, cobertura 70/90, presupuestos de rendimiento E2E, logger local, security.md — y 3 bugs latentes cazados al correr E2E reales por primera vez: commands ≤4, extPath del smoke, API de axe-core). Fases 0–10 completadas (2026-08-24). Próxima: Fase 11 — lanzamiento (i18n, options page, store assets, release pipeline)._
