// tests/ui/dragLogic.test.js — Decisiones puras de D&D (Fase 4.3).
// M14: cross-group respeta el índice destino · M15: drops inválidos → null (feedback).

import { describe, it, expect } from 'vitest';
import { resolveDrop, adjustForRemoval } from '../../ui/components/DragController.js';

/** @returns {import('../../ui/components/DragController.js').TabDrag} */
const tabDrag = (over = {}) => ({
  type: 'tab',
  tabId: 't1',
  groupId: 'gA',
  tabIndex: 0,
  ...over,
});

describe('adjustForRemoval', () => {
  it('mover hacia abajo compensa el hueco dejado', () => {
    expect(adjustForRemoval(1, 3)).toBe(2);
  });
  it('mover hacia arriba no cambia', () => {
    expect(adjustForRemoval(3, 1)).toBe(1);
  });
});

describe('resolveDrop · tab sobre tab del mismo grupo', () => {
  it('soltar encima (before) inserta antes del objetivo', () => {
    // [A,B,C,D], arrastro A(0) sobre C(2) por arriba:
    // remove(0)→[B,C,D], C quedó en idx1 → insertar en 1 → [B,A,C,D] (A antes de C)
    const d = resolveDrop(tabDrag({ tabIndex: 0 }), {
      kind: 'tab',
      groupId: 'gA',
      tabIndex: 2,
      before: true,
    });
    expect(d).toEqual({ op: 'reorderTab', groupId: 'gA', fromIndex: 0, toIndex: 1 });
  });

  it('soltar debajo (after) inserta después del objetivo con ajuste de hueco', () => {
    // [A,B,C,D], arrastro B(1) debajo de D(2) → insertAt=3, adjust(1→3)=2 → [A,C,B,D]
    const d = resolveDrop(tabDrag({ tabIndex: 1 }), {
      kind: 'tab',
      groupId: 'gA',
      tabIndex: 2,
      before: false,
    });
    expect(d).toEqual({ op: 'reorderTab', groupId: 'gA', fromIndex: 1, toIndex: 2 });
  });

  it('drop sobre sí mismo es null', () => {
    expect(
      resolveDrop(tabDrag({ tabIndex: 1 }), { kind: 'tab', groupId: 'gA', tabIndex: 1, before: true })
    ).toBeNull();
  });
});

describe('resolveDrop · tab cross-group (M14)', () => {
  it('respeta la posición destino en el grupo receptor', () => {
    const d = resolveDrop(tabDrag({ groupId: 'gA', tabIndex: 0 }), {
      kind: 'tab',
      groupId: 'gB',
      tabIndex: 1,
      before: true,
    });
    expect(d).toEqual({
      op: 'moveTab',
      tabId: 't1',
      fromGroupId: 'gA',
      toGroupId: 'gB',
      toIndex: 1, // YA NO se descarta: entra en esa posición
    });
  });

  it('after apunta al slot siguiente', () => {
    const d = /** @type {any} */ (
      resolveDrop(tabDrag({ groupId: 'gA' }), {
        kind: 'tab',
        groupId: 'ungrouped-drop',
        tabIndex: 4,
        before: false,
      })
    );
    expect(d.op).toBe('moveTab');
    expect(d.toIndex).toBe(5);
  });

  it('mover a la misma posición relativa nunca produce reorder fantasma', () => {
    // arrastro idx1 y lo suelto "después" de idx0 → insertAt=1 → toIndex=1 == from → null
    const d = resolveDrop(tabDrag({ groupId: 'gA', tabIndex: 1 }), {
      kind: 'tab',
      groupId: 'gA',
      tabIndex: 0,
      before: false,
    });
    expect(d).toBeNull();
  });
});

describe('resolveDrop · tab sobre header de grupo', () => {
  it('grupo distinto → moveTab al final (toIndex null)', () => {
    const d = resolveDrop(tabDrag({ groupId: 'gA' }), { kind: 'group-header', groupId: 'gC' });
    expect(d).toEqual({
      op: 'moveTab',
      tabId: 't1',
      fromGroupId: 'gA',
      toGroupId: 'gC',
      toIndex: null,
    });
  });

  it('mismo grupo → null', () => {
    expect(resolveDrop(tabDrag({ groupId: 'gA' }), { kind: 'group-header', groupId: 'gA' })).toBeNull();
  });
});

describe('resolveDrop · grupos', () => {
  /** @type {import('../../ui/components/DragController.js').GroupDrag} */
  const groupDrag = { type: 'group', groupId: 'g2', groupIndex: 1 };

  it('reordenar hacia arriba', () => {
    const d = resolveDrop(groupDrag, { kind: 'group', groupIndex: 3, before: true });
    expect(d).toEqual({ op: 'reorderGroups', fromIndex: 1, toIndex: 2 });
  });

  it('drop del grupo sobre sí mismo es null', () => {
    expect(resolveDrop(groupDrag, { kind: 'group', groupIndex: 1, before: true })).toBeNull();
  });

  it('tab drop sobre target de tipo incompatible → null (M15)', () => {
    expect(resolveDrop(tabDrag(), { kind: 'group', groupIndex: 0, before: true })).toBeNull();
    expect(resolveDrop(null, { kind: 'tab', groupId: 'x', tabIndex: 0, before: true })).toBeNull();
    expect(resolveDrop(tabDrag(), null)).toBeNull();
  });
});
