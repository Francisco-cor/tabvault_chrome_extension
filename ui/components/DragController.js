// ui/components/DragController.js — D&D de tabs/grupos en DetailView (instancia única).
// La DECISIÓN (qué operación ejecutar para un drop) es lógica pura testeable:
// resolveDrop(). El adaptador DOM solo pinta indicadores y ejecuta la decisión.
// Fixes: M14 (cross-group respeta índice destino) y M15 (feedback en drop inválido).

/**
 * @typedef {{ type:'tab', tabId:string, groupId:string|null, tabIndex:number }} TabDrag
 * @typedef {{ type:'group', groupId:string, groupIndex:number }} GroupDrag
 * @typedef {TabDrag|GroupDrag} Drag
 *
 * @typedef {{ kind:'tab', groupId:string|null, tabIndex:number, before:boolean }} DropTab
 * @typedef {{ kind:'group-header', groupId:string|null }} DropGroupHeader
 * @typedef {{ kind:'group', groupIndex:number, before:boolean }} DropGroup
 *
 * @typedef {null |
 *   { op:'reorderTab', groupId:string|null, fromIndex:number, toIndex:number } |
 *   { op:'moveTab', tabId:string, fromGroupId:string|null, toGroupId:string|null, toIndex:number|null } |
 *   { op:'reorderGroups', fromIndex:number, toIndex:number }} DropDecision
 */

/**
 * Ajusta un índice de inserción cuando el elemento movido sale del MISMO array
 * (splice remove-first): si venía de antes del punto de inserción, el hueco
 * desplaza el objetivo una posición a la izquierda.
 * @param {number} fromIndex @param {number} insertAt
 */
export function adjustForRemoval(fromIndex, insertAt) {
  return fromIndex < insertAt ? insertAt - 1 : insertAt;
}

/**
 * Decide la operación resultante de un drop. `null` = drop inválido.
 * @param {Drag|null} drag
 * @param {DropTab|DropGroupHeader|DropGroup|null} target
 * @returns {DropDecision}
 */
export function resolveDrop(drag, target) {
  if (!drag || !target) return null;
  if (drag.type === 'tab') return resolveTabDrop(drag, target);
  if (drag.type === 'group') return resolveGroupDrop(drag, target);
  return null;
}

/**
 * Decisiones cuando se arrastra una tab.
 * @param {TabDrag} drag
 * @param {DropTab|DropGroupHeader|DropGroup} target
 * @returns {DropDecision}
 */
function resolveTabDrop(drag, target) {
  if (target.kind === 'tab') {
    const t = /** @type {DropTab} */ (target);
    if (drag.groupId === t.groupId)
      return resolveSameListReorder(drag.tabIndex, t.tabIndex, t.before, drag.groupId);
    // Cross-group: respeta posición destino (M14). before → en ese slot; after → siguiente.
    return {
      op: 'moveTab',
      tabId: drag.tabId,
      fromGroupId: drag.groupId,
      toGroupId: t.groupId,
      toIndex: t.tabIndex + (t.before ? 0 : 1),
    };
  }
  if (target.kind === 'group-header') {
    const h = /** @type {DropGroupHeader} */ (target);
    if (drag.groupId === h.groupId) return null; // misma lista: nada que hacer
    return {
      op: 'moveTab',
      tabId: drag.tabId,
      fromGroupId: drag.groupId,
      toGroupId: h.groupId,
      toIndex: null, // al final del grupo destino
    };
  }
  return null;
}

/**
 * Reorden dentro de la MISMA lista (tabs de un grupo o grupos del detalle).
 * @param {number} fromIndex @param {number} targetIndex @param {boolean} before @param {string|null} groupId
 * @returns {{ op:'reorderTab', groupId:string|null, fromIndex:number, toIndex:number } | null}
 */
function resolveSameListReorder(fromIndex, targetIndex, before, groupId) {
  if (fromIndex === targetIndex) return null; // drop sobre sí mismo
  const insertAt = targetIndex + (before ? 0 : 1);
  const toIndex = Math.max(0, adjustForRemoval(fromIndex, insertAt));
  if (toIndex === fromIndex) return null;
  return { op: 'reorderTab', groupId, fromIndex, toIndex };
}

/**
 * Decisiones cuando se arrastra un grupo.
 * @param {GroupDrag} drag
 * @param {DropTab|DropGroupHeader|DropGroup} target
 * @returns {DropDecision}
 */
function resolveGroupDrop(drag, target) {
  if (target.kind !== 'group') return null;
  const g = /** @type {DropGroup} */ (target);
  const decision = resolveSameListReorder(drag.groupIndex, g.groupIndex, g.before, null);
  if (!decision) return null;
  return { op: 'reorderGroups', fromIndex: decision.fromIndex, toIndex: decision.toIndex };
}

/** Clases de indicador usadas por el controlador y el CSS existente. */
export const DROP_CLASSES = ['drag-over-top', 'drag-over-bottom', 'drag-over', 'dragging'];

/** Limpia todos los indicadores dentro de un contenedor. @param {HTMLElement} content */
export function clearIndicators(content) {
  for (const cls of DROP_CLASSES) {
    content.querySelectorAll(`.${cls}`).forEach((el) => el.classList.remove(cls));
  }
}

/**
 * Crea el controlador de D&D. Se registra UNA vez sobre #content en el bootstrap.
 * @param {{
 *   content: HTMLElement,
 *   getSessionId: () => string|null,
 *   exec: (decision: NonNullable<ReturnType<typeof resolveDrop>>, sessionId: string) => Promise<void>,
 * }} cfg
 */
export function createDragController({ content, getSessionId, exec }) {
  /** @type {Drag|null} */
  let dragData = null;

  content.addEventListener('dragstart', (e) => {
    const tabEl = /** @type {HTMLElement|null} */ (
      /** @type {HTMLElement} */ (e.target).closest('.detail-tab[draggable]')
    );
    const groupEl = /** @type {HTMLElement|null} */ (
      /** @type {HTMLElement} */ (e.target).closest('.detail-group[draggable]')
    );

    if (tabEl && !(/** @type {HTMLElement} */ (e.target).closest('.note-area'))) {
      dragData = {
        type: 'tab',
        tabId: tabEl.dataset.tabId ?? '',
        groupId: tabEl.dataset.groupId || null,
        tabIndex: parseInt(tabEl.dataset.tabIndex ?? '-1', 10),
      };
      tabEl.classList.add('dragging');
      const dt = /** @type {DataTransfer} */ (e.dataTransfer);
      dt.effectAllowed = 'move';
      dt.setData('text/plain', 'tab');
    } else if (groupEl && !(/** @type {HTMLElement} */ (e.target).closest('.detail-tab'))) {
      dragData = {
        type: 'group',
        groupId: groupEl.dataset.groupId ?? '',
        groupIndex: parseInt(groupEl.dataset.groupIndex ?? '-1', 10),
      };
      groupEl.classList.add('dragging');
      const dt = /** @type {DataTransfer} */ (e.dataTransfer);
      dt.effectAllowed = 'move';
      dt.setData('text/plain', 'group');
    }
  });

  content.addEventListener('dragover', (e) => {
    if (!dragData) return;
    e.preventDefault();
    const dt = /** @type {DataTransfer} */ (e.dataTransfer);
    dt.dropEffect = 'move';
    clearIndicators(content);

    const hit = hitTarget(/** @type {HTMLElement} */ (e.target), dragData);
    if (!hit.el) return;
    if (dragData.type === 'tab' && hit.kind === 'tab') {
      const t = /** @type {DropTab} */ (hit.target);
      hit.el.classList.add(t.before ? 'drag-over-top' : 'drag-over-bottom');
    } else {
      hit.el.classList.add('drag-over');
    }
  });

  content.addEventListener('drop', async (e) => {
    e.preventDefault();
    clearIndicators(content);
    const drag = dragData;
    dragData = null;
    const sessionId = getSessionId();
    if (!drag || !sessionId) {
      markInvalid(e);
      return;
    }

    const hit = hitTarget(/** @type {HTMLElement} */ (e.target), drag);
    const decision = resolveDrop(drag, hit.target ?? null);
    if (!decision) {
      markInvalid(e); // M15: feedback visual de drop inválido
      return;
    }
    await exec(decision, sessionId);
  });

  content.addEventListener('dragleave', (e) => {
    const t = /** @type {HTMLElement|null} */ (
      /** @type {HTMLElement} */ (e.target).closest('.detail-tab, .detail-group')
    );
    t?.classList.remove('drag-over-top', 'drag-over-bottom', 'drag-over');
  });

  content.addEventListener('dragend', () => {
    dragData = null;
    clearIndicators(content);
  });

  return {
    /** Solo tests: inyectar un drag simulado. @param {Drag|null} d */
    _setDrag(d) {
      dragData = d;
    },
  };
}

/** Shake breve sobre el contenedor ante drops sin efecto (M15). @param {DragEvent} e */
function markInvalid(e) {
  const card = /** @type {HTMLElement|null} */ (
    /** @type {HTMLElement} */ (e.target).closest('.detail-group, .detail-tab')
  );
  if (!card) return;
  card.classList.add('drop-invalid');
  setTimeout(() => card.classList.remove('drop-invalid'), 350);
}

/**
 * Determina objetivo de drop desde el punto del evento.
 * @param {HTMLElement} src
 * @param {Drag} drag
 * @returns {{ kind: string, el: HTMLElement|null, target?: DropTab|DropGroupHeader|DropGroup }}
 */
function hitTarget(src, drag) {
  if (drag.type === 'tab') {
    const tabEl = /** @type {HTMLElement|null} */ (src.closest('.detail-tab'));
    if (tabEl && !tabEl.classList.contains('dragging')) {
      const rect = tabEl.getBoundingClientRect();
      return {
        kind: 'tab',
        el: tabEl,
        target: {
          kind: 'tab',
          groupId: tabEl.dataset.groupId || null,
          tabIndex: parseInt(tabEl.dataset.tabIndex ?? '-1', 10),
          before: lastY < rect.top + rect.height / 2,
        },
      };
    }
    const headerEl = /** @type {HTMLElement|null} */ (src.closest('.detail-group-header'));
    if (headerEl) {
      const groupEl = /** @type {HTMLElement|null} */ (headerEl.closest('.detail-group'));
      return {
        kind: 'group-header',
        el: groupEl,
        target: { kind: 'group-header', groupId: groupEl?.dataset.groupId ?? null },
      };
    }
    return { kind: 'none', el: null };
  }

  const groupEl = /** @type {HTMLElement|null} */ (src.closest('.detail-group'));
  if (groupEl && !groupEl.classList.contains('dragging')) {
    const rect = groupEl.getBoundingClientRect();
    return {
      kind: 'group',
      el: groupEl,
      target: {
        kind: 'group',
        groupIndex: parseInt(groupEl.dataset.groupIndex ?? '-1', 10),
        before: lastY < rect.top + rect.height / 2,
      },
    };
  }
  return { kind: 'none', el: null };
}

/** Última posición Y conocida del puntero (los dragover no siempre traen clientY usable). */
let lastY = 0;
if (typeof window !== 'undefined') {
  window.addEventListener(
    'dragover',
    (e) => {
      lastY = e.clientY;
    },
    true
  );
}

// ─── D&D de session cards (orden manual, Fase 7.5) ───────────────────────────

/**
 * Índice destino puro para reordenar cards. Ajusta el hueco del arrastrado.
 * Devuelve -1 si el movimiento es no-op.
 * @param {number} fromIndex @param {number} targetIndex @param {boolean} before @param {number} total
 */
export function resolveCardDropIndex(fromIndex, targetIndex, before, total) {
  if (fromIndex < 0 || fromIndex >= total || targetIndex < 0 || targetIndex >= total) return -1;
  if (fromIndex === targetIndex) return -1;
  let insertAt = before ? targetIndex : targetIndex + 1;
  if (fromIndex < insertAt) insertAt--;
  const toIndex = Math.max(0, Math.min(insertAt, total - 1));
  return toIndex === fromIndex ? -1 : toIndex;
}

/**
 * Controlador de D&D para las session cards en modo sort "Manual".
 * Instancia ÚNICA sobre #content (mismo patrón que el controller del detalle):
 * solo arrastra cuando la card lo declara (`draggable` solo se emite con
 * sortBy=manual) y ejecuta via exec(draggedId, toIndex).
 *
 * @param {{
 *   content: HTMLElement,
 *   exec: (draggedId: string, toIndex: number) => Promise<void>|void,
 * }} cfg
 */
export function createCardDragController({ content, exec }) {
  /** @type {{ id: string, index: number } | null} */
  let drag = null;

  content.addEventListener('dragstart', (e) => {
    const card = /** @type {HTMLElement|null} */ (
      /** @type {HTMLElement} */ (e.target).closest('.session-card[draggable="true"]')
    );
    // El botón de pin/restore dentro de la card no debe iniciar drag.
    if (!card || /** @type {HTMLElement} */ (e.target).closest('button, input, [contenteditable]')) {
      drag = null;
      return;
    }
    drag = { id: card.dataset.id ?? '', index: parseInt(card.dataset.cardIndex ?? '-1', 10) };
    card.classList.add('dragging');
    const dt = /** @type {DataTransfer} */ (e.dataTransfer);
    dt.effectAllowed = 'move';
    dt.setData('text/plain', 'session-card');
  });

  content.addEventListener('dragover', (e) => {
    if (!drag) return;
    e.preventDefault();
    const dt = /** @type {DataTransfer} */ (e.dataTransfer);
    dt.dropEffect = 'move';
    clearIndicators(content);
    const hit = cardHit(e.target);
    if (!hit.el) return;
    hit.el.classList.add(hit.before ? 'drag-over-top' : 'drag-over-bottom');
  });

  content.addEventListener('drop', async (e) => {
    if (!drag) return;
    e.preventDefault();
    const current = drag;
    drag = null;
    clearIndicators(content);

    const hit = cardHit(e.target);
    if (!hit.el || !current.id) return markInvalidCard(/** @type {HTMLElement} */ (hit.el));
    const toIndex = resolveCardDropIndex(current.index, hit.index, hit.before, hit.total);
    if (toIndex === -1) return undefined;
    await exec(current.id, toIndex);
    return undefined;
  });

  content.addEventListener('dragleave', (e) => {
    const t = /** @type {HTMLElement|null} */ (
      /** @type {HTMLElement} */ (e.target)?.closest('.session-card')
    );
    t?.classList.remove('drag-over-top', 'drag-over-bottom');
  });

  content.addEventListener('dragend', () => {
    drag = null;
    clearIndicators(content);
    content.querySelectorAll('.session-card.dragging').forEach((el) => el.classList.remove('dragging'));
  });
}

/** Objetivo de drop sobre una card. @param {EventTarget|null} src */
function cardHit(src) {
  const card = /** @type {HTMLElement|null} */ (
    /** @type {HTMLElement|null} */ (src)?.closest?.('.session-card[data-card-index]') ?? null
  );
  if (!card || card.classList.contains('dragging')) return { el: null, index: -1, before: false, total: 0 };
  const rect = card.getBoundingClientRect();
  return {
    el: card,
    index: parseInt(card.dataset.cardIndex ?? '-1', 10),
    before: lastY < rect.top + rect.height / 2,
    total: document.querySelectorAll('.session-card[data-card-index]').length,
  };
}

/** Shake breve ante drop sin efecto. @param {HTMLElement} el */
function markInvalidCard(el) {
  el.classList.add('drop-invalid');
  setTimeout(() => el.classList.remove('drop-invalid'), 350);
}
