// tests/ui/virtualList.test.js — Ventana virtual pura (Fase 4.2).

import { describe, it, expect } from 'vitest';
import { computeWindow, VIRTUALIZE_THRESHOLD } from '../../ui/components/VirtualList.js';

describe('computeWindow', () => {
  it('lista vacía → ventana vacía', () => {
    expect(computeWindow({ itemCount: 0, rowHeight: 80, scrollTop: 0, viewportHeight: 480 })).toEqual({
      start: 0,
      end: 0,
      padTop: 0,
      padBottom: 0,
    });
  });

  it('scrollTop 0 muestra el principio + overscan', () => {
    const w = computeWindow({ itemCount: 100, rowHeight: 80, scrollTop: 0, viewportHeight: 480 });
    // viewport 480/80 = 6 filas visibles; overscan 6 por lado
    expect(w.start).toBe(0);
    expect(w.end).toBe(12);
    expect(w.padTop).toBe(0);
    expect(w.padBottom).toBe((100 - 12) * 80);
  });

  it('a mitad de la lista centra la ventana alrededor del scroll', () => {
    const w = computeWindow({ itemCount: 500, rowHeight: 80, scrollTop: 4000, viewportHeight: 480 });
    // fila 50 en el borde superior; ventana ≈ [44, 62]
    expect(w.start).toBe(44);
    expect(w.end).toBe(62);
    expect(w.padTop).toBe(44 * 80);
    expect(w.padBottom).toBe((500 - 62) * 80);
  });

  it('clamp al final de la lista', () => {
    const w = computeWindow({
      itemCount: 30,
      rowHeight: 80,
      scrollTop: 100000,
      viewportHeight: 480,
    });
    expect(w.end).toBe(30);
    expect(w.start).toBeGreaterThan(0);
    expect(w.padBottom).toBe(0);
  });

  it('listas más pequeñas que el viewport se muestran completas', () => {
    const w = computeWindow({ itemCount: 5, rowHeight: 80, scrollTop: 40, viewportHeight: 480 });
    expect(w.start).toBe(0);
    expect(w.end).toBe(5);
    expect(w.padTop + w.padBottom).toBe(0);
  });

  it('rowHeight inválida no divide por cero', () => {
    const w = computeWindow({ itemCount: 10, rowHeight: 0, scrollTop: 0, viewportHeight: 480 });
    expect(w).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 });
  });

  it('VIRTUALIZE_THRESHOLD deja listas cortas sin virtualizar', () => {
    expect(VIRTUALIZE_THRESHOLD).toBeGreaterThanOrEqual(20);
  });
});
