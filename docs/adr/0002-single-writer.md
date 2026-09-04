# ADR-0002: Escritor único (single-writer) para chrome.storage

- Estado: Propuesto (se implementará en Fase 2)
- Fecha: 2026-08-22

## Contexto

Hoy popup y service worker escriben ambos en `chrome.storage.local` mediante lectura-modificación-escritura del objeto completo `sessions`. Dos escrituras concurrentes pueden pisarse (lost updates) y la caché por contexto queda obsoleta al no existir suscripción a `chrome.storage.onChanged`.

## Decisión

El **service worker será el único escritor** del estado durable (`sessions`, `trash`, `versions`). El popup y el side panel envían comandos por `chrome.runtime.sendMessage` y actualizan su UI de forma optimista, reconciliando con la respuesta. Las excepciones de bajo riesgo (settings triviales) podrán escribirse localmente si se documenta.

Ambos contextos se suscriben a `chrome.storage.onChanged` para reflejar cambios ajenos.

## Consecuencias

- Elimina lost updates por diseño, no por suerte.
- Simplifica el razonamiento sobre consistencia.
  − Cada operación de UI requiere un mensaje al SW (+latencia ~ms, aceptable).
  − Requiere contrato de mensajes tipado y estable (`shared/messages.js`).

## Alternativas descartadas

- **Locks distribuidos / semáforos en storage**: complejos y frágiles con el ciclo de vida MV3.
- **Mantener escritura dual + onChanged merge**: resuelve síntomas, no la causa.
