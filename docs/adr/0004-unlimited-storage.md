# ADR-0004: `unlimitedStorage` se conserva — el tope real lo pone el LRU de favicons

## Contexto

La Fase 10.3 pedía revisar si `unlimitedStorage` sigue siendo necesario
(M4: el % de cuota mostrado era engañoso con ese permiso). Con la Fase 10.2
el perfil de storage cambió:

| Componente                      | Tamaño típico / tope                                     |
| ------------------------------- | -------------------------------------------------------- |
| Sesiones + papelera + versiones | ~1–6 MB (5k tabs, texto; versiones/backups SIN favicons) |
| `favicons` (LRU, Fase 10.2)     | tope duro **2 000 dominios / ~20 MB**                    |
| Cuota base `storage.local`      | 10 MB (desde Chrome 114; 5 MB antes)                     |

Sin `unlimitedStorage`, el store LRU de favicons no cabe: 20 MB de presupuesto
exceden la cuota base y las escrituras empezarían a fallar justo cuando el
usuario más se beneficia del cacheo (muchos dominios distintos).

## Decisión

1. **`unlimitedStorage` se CONSERVA.** Es la condición que permite el
   presupuesto explícito de favicons (~20 MB) sin sorpresas de cuota.
2. **El tope real ya no es la cuota sino el LRU**: `FAVICON_LIMITS`
   (2 000 dominios / 20 MB) acota el crecimiento; las sesiones de texto
   siguen dominadas por el cap de import (20 MB) y los límites anti-bloat de
   `schema.js`.
3. **La UI deja de mostrar % de cuota** (engañoso con unlimitedStorage) y pasa
   a mostrar **bytes reales** (`getBytesInUse`) en Stats/Settings. M4 queda
   resuelto por la rama "cambiar la estrategia de advertencia" del roadmap.

## Consecuencias

- El store de favicons es prescindible por diseño: si algo falla, la UI cae al
  fallback `chrome://favicon2` y al identicon — cero pérdida de datos.
- `getUsagePercent()` se mantiene por compatibilidad pero deja de ser el
  indicador primario; el KPI de storage usa bytes reales.
- Si algún día se elimina `unlimitedStorage`, hay que bajar
  `FAVICON_LIMITS.MAX_BYTES` a <5 MB y documentar el cambio de comportamiento.
