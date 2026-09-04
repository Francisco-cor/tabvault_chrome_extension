# TabVault — Modelo de amenazas y decisiones de seguridad

> Fase 10.3. Alcance: una extensión MV3 **local-first** sin backend. El
> principio rector es el #4 del plan: **sin `innerHTML` con datos crudos** —
> y su correlato a nivel datos: nada peligroso puede EXISTIR en storage.

## Superficie y activos

| Activo                           | Dónde vive                                        |
| -------------------------------- | ------------------------------------------------- |
| Sesiones, notas, tags, rutinas   | `chrome.storage.local`                            |
| Favicons (data-URLs por dominio) | `chrome.storage.local.favicons` (LRU)             |
| Backups ring-buffer              | `chrome.storage.local.backups`                    |
| Preferencias (opt-in sync)       | `chrome.storage.sync`                             |
| Logs de diagnóstico              | `chrome.storage.session` (muere con el navegador) |

No hay red propia: la única salida de red son (a) la descarga del favicon de
una tab al capturarla (fetch del `favIconUrl` que Chrome ya descargó) y
(b) `chrome://favicon2` para el fallback visual. Sin telemetría.

## Vectores y mitigaciones

### 1. Import malicioso (C7/C8, endurecido en Fase 8)

- `validateImportPayload` es la única puerta: rechaza claves reservadas
  (`__proto__`/`constructor`/`prototype`), caps globales (20 MB texto,
  5 000 sesiones), y normaliza TODA entidad (lo irrecuperable se descarta con
  reporte itemizado).
- Los importadores de terceros (OneTab/Session Buddy/Netscape/lista de URLs)
  convierten al MISMO payload `{_tabvault:true}` y re-validan en el mismo
  pipeline: la conversión no es una vía de escape.
- Fuzzing en CI: 1 000 documentos hostiles/iteración (PRNG semillado) — el
  import nunca corrompe storage ni contamina `Object.prototype`.

### 2. URLs peligrosas (`javascript:`, `data:`)

- **A nivel datos** (defensa primaria): `safeUrl()`/`safeFavicon()` en toda
  lectura Y escritura (`schema.js`). Un `javascript:` no puede EXISTIR en
  storage; por tanto nada puede renderizarlo.
- **A nivel render** (defensa en profundidad): los links pasan por `safeHref()`
  (solo http/https navegan) y todo valor dinámico va por `escapeHtml()`/
  `escapeAttr()`.

### 3. XSS almacenado vía render

- Regla ESLint custom **`tabvault/safe-html`** (gate de CI, tests con
  RuleTester en `tests/lint/safeHtml.test.js`):
  1. Los sinks de HTML (`innerHTML`/`outerHTML`/`insertAdjacentHTML`) solo
     pueden existir en los módulos de construcción de UI
     (`ui/render.js`, `ui/main.js`, `ui/components/`, `ui/actions/`,
     `ui/views/`, `newtab/newtab.js`). Cero sinks en core/shared/background.
  2. Dentro de esos módulos está PROHIBIDA la interpolación cruda
     (`${session.name}`, `${tab.url}`): todo valor debe pasar por un helper
     (`escapeHtml`/`escapeAttr`/`safeHref`/…) o estar en la lista mínima de
     nombres confiables (colores del sistema, índices numéricos). Las CALL
     expressions se consideran helpers por convención — revisar en PR que el
     helper escapee.
- Convención de escape: `escapeHtml` para texto, `escapeAttr` para atributos
  (mismo juego de entidades: comillas dobles/simples incluidas).

### 4. CSP y código remoto

- Manifest MV3 con CSP explícita para `extension_pages`:
  `script-src 'self'; object-src 'self'; img-src 'self' data: chrome://favicon2`.
  Sin `unsafe-eval`, sin remotes, sin WASM externo. El repo es no-build
  (ADR-0001): todo script servido es el del paquete.
- `img-src data:` es necesario para los favicons del store LRU (data-URLs
  saneadas por `safeFavicon`: solo `data:image/(png|jpeg|webp|gif|x-icon)`).
- Sin `externally_connectable` (ausente a propósito): otras webs NO pueden
  mandar mensajes a la extensión; no existe ningún listener
  `onMessageExternal` (verificado por grep en CI de revisión manual).

### 5. Permisos (superficie mínima)

| Permiso                        | Justificación                                                              |
| ------------------------------ | -------------------------------------------------------------------------- |
| `tabs`, `tabGroups`, `windows` | Función núcleo: capturar/restaurar sesiones con grupos                     |
| `storage`                      | Persistencia local                                                         |
| `unlimitedStorage`             | ADR-0004: presupuesto LRU de favicons (~20 MB) > cuota base 10 MB          |
| `sidePanel`                    | Superficie alternativa                                                     |
| `contextMenus`                 | Guardar/stash desde el menú de página                                      |
| `alarms`                       | Auto-saves, purga de papelera, backups, rutinas (sin SW vivo)              |
| `notifications`                | Rutinas programadas (Fase 9.4)                                             |
| `favicon`                      | Endpoint `chrome://favicon2` como fallback visual (sin warning de install) |
| `history` (**opcional**)       | Bloque "también en tu historial" en búsqueda — opt-in explicado en UI      |

- `host_permissions`: NINGUNO. El fetch del favicon va al `favIconUrl` exacto
  que Chrome ya descargó para esa tab; si falla, se degrada sin error.

### 6. Favicons (Fase 10.2)

- Un dato por DOMINIO en `favicons` (LRU 2 000 dominios / ~20 MB, ADR-0004).
- `safeFavicon` filtra el tipo; el render nunca interpola el dato sin
  `escapeAttr` (regla safe-html).
- Privacidad: mostrar favicons vía `chrome://favicon2` no añade red más allá
  de la que el propio navegador ya hizo para la pestaña; el store LRU es
  local y se purga por LRU.

### 7. Diagnósticos (Fase 10.5)

- Logger con niveles + ring-buffer en `storage.session` (cap 200, muere al
  cerrar el navegador). Sin red. "Copy report" en Settings arma el informe
  localmente; el usuario decide copiarlo/compartirlo.

## Qué NO está en scope

- Cifrado en reposo de `storage.local` (requeriría passphrase al arrancar; el
  export cifrado `.tabvault.enc` cubre el caso de backups fuera del dispositivo).
- Aislamiento de otros extensions: fuera del modelo de amenazas de Chrome.
- Tamper físico del perfil del navegador (mismo riesgo que cualquier extensión).
