// shared/types.js — Tipos del dominio TabVault (JSDoc, sin build)
// Fuente única de verdad para la forma de los datos en storage y mensajes.

/**
 * Una tab guardada dentro de una sesión.
 *
 * @typedef {Object} TabItem
 * @property {string} id            UUID
 * @property {string} url           URL absoluta (solo http/https tras sanitizar)
 * @property {string} title
 * @property {string} favicon       siempre '' desde Fase 10 (los favicons viven en el store LRU por dominio)
 * @property {string} [note]
 * @property {string[]} [tags]
 * @property {number} savedAt       epoch ms
 * @property {boolean} [pinned]     true si estaba fijada al capturar (Fase 3)
 * @property {boolean} [active]     true si era la tab activa al capturar (Fase 3)
 */

/**
 * Grupo de tabs dentro de una sesión (espejo de chrome.tabGroups).
 *
 * @typedef {Object} Group
 * @property {string} id            UUID (no es el groupId nativo)
 * @property {string} name
 * @property {'grey'|'blue'|'red'|'yellow'|'green'|'pink'|'purple'|'cyan'|'orange'} color
 * @property {string[]} tags
 * @property {string} note
 * @property {TabItem[]} tabs
 */

/**
 * Metadatos derivados — SIEMPRE recalcular con computeMetadata(), nunca confiar.
 *
 * @typedef {Object} SessionMetadata
 * @property {number} groupCount
 * @property {number} tabCount
 */

/**
 * Sesión guardada.
 *
 * @typedef {Object} Session
 * @property {string} id
 * @property {string} name
 * @property {number} created       epoch ms
 * @property {number} updated       epoch ms
 * @property {Group[]} groups
 * @property {TabItem[]} ungroupedTabs
 * @property {SessionMetadata} metadata
 * @property {boolean} [autoSaved]  creado por auto-save (periódico o cierre)
 * @property {boolean} [pinned]
 * @property {boolean} [isTemplate] plantilla: restaurarla NO marca uso (Fase 6.3)
 * @property {boolean} [stash]      sesión especial "Stash" del stash rápido (Fase 6.1)
 * @property {number} [lastOpened]  epoch ms del último restore (las plantillas no lo tocan)
 * @property {string[]} [tags]      tags de NIVEL SESIÓN (Fase 7.3)
 * @property {number} [order]       posición del orden manual (Fase 7.5); ausente = sin ordenar
 * @property {number} [openCount]   nº de restores (ranking de búsqueda, Fase 7.1)
 */

/**
 * Sesión en papelera.
 *
 * @typedef {Session & { deletedAt: number }} TrashEntry
 */

/**
 * Snapshot inmutable de una sesión para versionado.
 *
 * @typedef {Object} SnapshotEntry
 * @property {Session} snapshot     sin favicons (se vacían al guardar versión)
 * @property {number} savedAt
 */

/**
 * Preferencias del usuario.
 *
 * @typedef {Object} Settings
 * @property {'dark'|'light'|'system'} theme    'system' sigue prefers-color-scheme
 * @property {'blue'|'purple'|'green'|'orange'} accent
 * @property {'newest'|'oldest'|'az'|'za'|'tabs'|'manual'} sortBy   manual = orden D&D (Fase 7.5)
 * @property {0|5|15|30|60} autoSaveMinutes   0 = off
 * @property {boolean} autoSaveOnClose        auto-guardar al cerrar ventana (Fase 3)
 * @property {boolean} includeIncognito       incluir ventanas incógnito en capturas
 * @property {number} minAutoSaveTabs         mín. tabs para que un auto-save guarde (1–50)
 * @property {boolean} syncEnabled            SOLO preferencias (ver ADR-0002)
 * @property {number} trashPurgeDays          días antes de purgar papelera (1–365)
 * @property {boolean} dedupeOnRestore        enfocar URL existente en vez de duplicar
 * @property {boolean} dedupeOnSave           fusionar tabs con misma URL al guardar (Fase 6.1)
 * @property {string[]} excludedDomains       dominios desmarcados por defecto en el modal (Fase 6.1)
 * @property {number} dupThreshold            umbral Jaccard % para avisar de duplicados (50–95, Fase 6.4)
 * @property {boolean} onboardingDone         overlay de bienvenida ya mostrado (Fase 5)
 * @property {string} workspace               workspace activo del switcher ('' = todos, Fase 7.4)
 * @property {number} lastManualExport        epoch ms del último export manual (0 = nunca, Fase 8)
 * @property {number} reminderDismissedAt     epoch ms del último dismiss del recordatorio (Fase 8)
 * @property {boolean} newTabEnabled          reemplaza NTP con newtab.html (Fase 9.6, opt-in)
 * @property {boolean} historyEnabled         muestra historial reciente en búsqueda (Fase 9.7)
 * @property {number} suspendHours            umbral suspensión memoria (1-72h, Fase 9.3)
 * @property {string[]} focusWhitelist        dominios nunca cerrados por focus mode (Fase 9.2)
 */

/**
 * Rutina programada (Fase 9.4).
 * @typedef {Object} Routine
 * @property {string} id
 * @property {string} sessionId
 * @property {string} time     HH:MM 24h
 * @property {boolean} enabled
 * @property {number} created
 */

/**
 * Regla de auto-tag (Fase 9.5).
 * @typedef {Object} AutoTagRule
 * @property {string} id
 * @property {string} pattern  substring lowercase de URL
 * @property {string} tag
 */

/** Mapa id → sesión tal como vive en chrome.storage.local.sessions */
/** @typedef {Record<string, Session>} SessionMap */

/** Mapa id → entrada de papelera (chrome.storage.local.trash) */
/** @typedef {Record<string, TrashEntry>} TrashMap */

/** Mapa sessionId → snapshots (chrome.storage.local.versions) */
/** @typedef {Record<string, SnapshotEntry[]>} VersionMap */

/** Archivo de export/import completo.
 * @typedef {Object} ExportFile
 * @property {true} _tabvault
 * @property {number} version      schemaVersion del export
 * @property {SessionMap} [sessions]
 * @property {TrashMap} [trash]
 * @property {VersionMap} [versions]
 * @property {Settings} [settings]
 */

export {}; // módulo solo de tipos
