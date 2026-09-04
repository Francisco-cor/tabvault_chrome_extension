# TabVault

A Chrome extension for saving, organizing, and restoring tab sessions — with notes, free tags, and fuzzy search. Everything stored locally; no account, no sync, no tracking.

![Chrome MV3](https://img.shields.io/badge/Manifest-V3-4169e1?style=flat-square)
![Vanilla JS](https://img.shields.io/badge/JS-ES%20Modules-f0eff4?style=flat-square&labelColor=1d1d20)
![Local only](https://img.shields.io/badge/Storage-Local%20only-22c55e?style=flat-square)

---

## Features

| Feature               | Description                                             |
| --------------------- | ------------------------------------------------------- |
| **Session snapshots** | Save all open tabs and groups in one click              |
| **Restore sessions**  | Open a saved session in a new window with groups intact |
| **Notes**             | Add a note to any tab or group                          |
| **Free tags**         | Tag sessions and groups with custom labels              |
| **Fuzzy search**      | Search across titles, URLs, notes, and tags             |
| **Export**            | Export any session as JSON or Markdown                  |
| **Import / Backup**   | Full data import from a JSON backup file                |
| **Live groups view**  | Browse the current window's tab groups                  |

---

## Install (developer mode)

1. Clone the repo

   ```sh
   git clone https://github.com/your-username/tabvault_chrome_extension.git
   cd tabvault_chrome_extension
   ```

2. Generate icons

   ```sh
   node generate-icons.cjs
   ```

3. Open Chrome → `chrome://extensions`

4. Enable **Developer mode** (top-right toggle)

5. Click **Load unpacked** → select the project folder

The TabVault icon appears in your toolbar. Pin it for quick access.

---

## Project structure

```
tabvault_chrome_extension/
├── manifest.json              # MV3 · CSP explícita · minimum_chrome_version 116
├── background/                # Service worker modular
│   ├── sw-main.js             # Entry: registra listeners; sin lógica
│   └── handlers/
│       ├── capture.js         # Capturador compartido (favicons UNA vez por dominio)
│       ├── restore.js         # Restore paralelo: pinned/active, modos new/append/replace/incognito
│       ├── autosave.js        # Snapshots en storage.session (fix C1) + periódico (fix C5)
│       ├── focus.js           # Modo enfoque con undo + suspensión de memoria (Fase 9)
│       ├── routines.js        # Rutinas programadas vía alarms (Fase 9)
│       ├── messages.js        # Router {ok,data?,error?} + timeouts + whitelist REPO_OP
│       └── lifecycle.js       # Badge por alarm (M5), context menus (M1), openPopup fallback (M2)
├── core/                      # Núcleo puro (sin chrome.*)
│   ├── repository.js          # Repositorio transaccional (cola de escritura + onChanged)
│   ├── schema.js              # Normalizadores/validadores (safeUrl/safeFavicon, límites)
│   ├── domain.js              # Funciones puras (metadata, dedupe, merge, duplicados)
│   ├── favicons.js            # Store LRU de favicons por dominio (Fase 10)
│   ├── searchIndex.js         # Índice invertido con ranking (Fase 7)
│   ├── stats.js               # KPIs on-demand del dashboard (Fase 9)
│   ├── crypto.js              # Export cifrado AES-GCM (Fase 8)
│   └── migrations.js          # Versionado de esquema (v4) con backup e idempotencia
├── shared/                    # messages, types, urlRules, utils, logger (ring-buffer local)
├── ui/                        # Arquitectura de componentes: store + vistas + acciones
├── popup/  sidepanel/  newtab/
├── styles/                    # tokens/base/components/views (design system)
├── tests/                     # Vitest unit + Playwright E2E (smoke/flows/perf/a11y)
├── docs/                      # ADRs + docs/security.md (modelo de amenazas)
└── generate-icons.cjs         # Node script — crea PNG icons sin dependencias
```

---

## Storage schema

All data lives in `chrome.storage.local`. No remote calls are ever made.

```jsonc
{
  "sessions": {
    "<id>": {
      "id": "string",
      "name": "string",
      "created": 1234567890,
      "updated": 1234567890,
      "groups": [
        {
          "id": "string",
          "name": "string",
          "color": "purple", // Chrome group color
          "tags": ["work", "research"],
          "note": "string",
          "tabs": [
            {
              "id": "string",
              "url": "https://...",
              "title": "string",
              "favicon": "", // Fase 10: siempre '' — los favicons viven en el store LRU por dominio
              "note": "string",
              "tags": [],
              "savedAt": 1234567890,
            },
          ],
        },
      ],
      "ungroupedTabs": [], // tabs outside any group
      "metadata": {
        "groupCount": 2,
        "tabCount": 14,
      },
    },
  },
  "settings": {
    "theme": "dark",
  },
  "favicons": {
    // Fase 10: LRU por dominio — cap 2 000 dominios / ~20 MB (ADR-0004)
    "entries": {
      "github.com": { "data": "data:image/png;base64,...", "usedAt": 1234567890 },
    },
    "bytes": 12345,
  },
}
```

---

## Export formats

**JSON** — full session data, re-importable by TabVault on any device.

**Markdown** — human-readable link list, useful for notes or sharing:

```markdown
# My Work Session

> Saved: 3/20/2026, 11:00 PM

## Research

_Tags: ai, papers_

- [Attention Is All You Need](https://arxiv.org/abs/1706.03762)
- [GPT-4 Technical Report](https://openai.com/research/gpt-4)
```

---

## Tech notes

- **No build step** — plain ES modules, works directly in Chrome (ADR-0001)
- **Single writer** — solo el service worker escribe estado; el popup propone vía mensajes (ADR-0002)
- **Favicons LRU por dominio** — una entrada por dominio (cap 2 000 / ~20 MB) en vez de una data-URL por tab; fallback `chrome://favicon2` → identicon determinista
- **Seguridad** — CSP explícita, `safeUrl()`/`safeFavicon()` en toda lectura/escritura, regla ESLint `tabvault/safe-html`, modelo de amenazas en `docs/security.md`
- **Fuzzy search** — índice invertido con ranking combinado (texto + frescura + pins + uso)
- **Icons** — generated programmatically via `generate-icons.cjs` using raw PNG/zlib (no dependencies)

---

## Development

```sh
npm install              # devDependencies only (no runtime deps, no build)
npm test                 # unit tests (Vitest) — 522 tests
npm run test:coverage    # + cobertura (gates: ≥70% global, ≥90% líneas core/)
npm run lint             # ESLint (incl. regla custom tabvault/safe-html)
npm run typecheck        # TypeScript checkJs
npm run format           # Prettier
npm run test:e2e         # Playwright E2E (smoke + flows + perf + a11y; requiere npx playwright install chromium)
npm run zip              # store-ready zip (tabvault-v<version>.zip)
node scripts-dev/check-zip.mjs   # verifica contenido + presupuesto de bundle ≤250KB
```

CI runs lint + typecheck + format + tests + coverage + E2E (con presupuestos de rendimiento y auditoría axe-core) en cada PR, y publica el reporte de cobertura como artefacto. See `CONTRIBUTING.md`, `docs/security.md` and `ROADMAP.md`.

---

## License

MIT
