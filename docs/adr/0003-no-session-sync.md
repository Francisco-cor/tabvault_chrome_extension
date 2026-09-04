# ADR-0003: Las sesiones NO se sincronizan — solo preferencias

## Contexto

El toggle de settings "Sync" (heredado) escribía `settings` en
`chrome.storage.sync` y nada más. La UI sugería implícitamente que las
sesiones viajaban también. Fase 8.4 exige honestidad y una decisión
documentada sobre sincronizar sesiones con chunking.

Límites reales de `chrome.storage.sync`:

| Límite                | Valor                           |
| --------------------- | ------------------------------- |
| Cuota total           | 102 400 B                       |
| Por ítem              | 8 192 B                         |
| Máx. ítems            | 512                             |
| Escrituras por minuto | 1 800 ops/min, 1 800 000 B/10 s |

Un vault realista (200 sesiones × 20 tabs, títulos+notas+tags, SIN favicons)
ronda 2–6 MB. Incluso con chunking de 8 KB son cientos de ítems y un coste de
sincronización constante en cada mutación (el single-writer escribiría por
cada save/update), con riesgo de QUOTA_BYTES_PER_ITEM y de carreras de merge
entre dispositivos que `storage.sync` no resuelve (no hay CRDT ni last-writer
confiable por sesión).

## Decisión

1. **Solo preferencias se sincronizan** (`theme`, `accent`, `sortBy`).
   El toggle se renombra a "Sync preferences across devices" y su descripción
   declara explícitamente que las sesiones permanecen locales.
2. **Las sesiones son local-only.** La portabilidad entre dispositivos es el
   export/import multi-formato de la Fase 8 (JSON, Bookmarks HTML,
   `.tabvault.enc` cifrado). Un archivo es revisable, auditable y no depende
   de cuotas ocultas.
3. No se implementa chunking de sesiones vía `storage.sync`.

## Consecuencias

- M10 cerrado: ningún toggle sugiere más de lo que hace.
- Los usuarios con varios dispositivos usan export/import manual; el
  recordatorio de backup (banner + alarm diaria) mitiga el olvido.
- Si en el futuro aparece demanda real, la vía correcta sería un dispositivo
  de sync propio (archivo en Drive/WebDAV) o E2EE con CRDT — fuera del scope 2.0.
