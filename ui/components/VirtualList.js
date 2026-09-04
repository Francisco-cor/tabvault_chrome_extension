// ui/components/VirtualList.js — Lista virtualizada sin dependencias (Fase 4.2).
// computeWindow() es lógica pura testeable. La vista pinta el contenedor; el hook
// after() llama a virtualize() que pinta la ventana inicial y registra la región en
// un ScrollBus ÚNICO sobre #content — nunca se acumulan listeners por render (C6).

/**
 * Ventana visible para N filas de altura fija.
 * @param {{ itemCount: number, rowHeight: number, scrollTop: number,
 *           viewportHeight: number, overscan?: number }} p
 * @returns {{ start: number, end: number, padTop: number, padBottom: number }}
 */
export function computeWindow({ itemCount, rowHeight, scrollTop, viewportHeight, overscan = 6 }) {
  if (itemCount <= 0 || rowHeight <= 0) {
    return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  }
  const startRaw = Math.floor(scrollTop / rowHeight) - overscan;
  const endRaw = Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan;
  const start = Math.max(0, Math.min(Math.max(0, startRaw), itemCount));
  const end = Math.max(start, Math.min(endRaw, itemCount));
  return {
    start,
    end,
    padTop: start * rowHeight,
    padBottom: Math.max(0, (itemCount - end) * rowHeight),
  };
}

/** Umbral de filas a partir del cual conviene virtualizar. */
export const VIRTUALIZE_THRESHOLD = 30;

/** Contenedor del popup marcado por la vista para alojar la lista virtual. */
export const VL_ATTR = 'data-vl';

// ─── ScrollBus único ──────────────────────────────────────────────────────────
/** @type {Set<{root: HTMLElement, paint: () => void}>} */
const liveLists = new Set();
let busInstalled = false;

/**
 * Instala (una sola vez) el listener de scroll que alimenta todas las listas vivas.
 * @param {HTMLElement} container
 */
export function installScrollBus(container) {
  if (busInstalled) return;
  busInstalled = true;
  let ticking = false;
  container.addEventListener(
    'scroll',
    () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        for (const list of [...liveLists]) {
          if (!list.root.isConnected) {
            liveLists.delete(list);
            continue;
          }
          list.paint();
        }
      });
    },
    { passive: true }
  );
}

/**
 * Pinta y conecta una región virtualizada. Llamar desde after().
 * @param {HTMLElement} mount
 * @param {(win: ReturnType<typeof computeWindow>) => string} paintWindow
 *   Devuelve el HTML interno de la región para una ventana dada.
 */
export function virtualize(mount, paintWindow) {
  const region = /** @type {HTMLElement|null} */ (mount.querySelector(`[${VL_ATTR}]`));
  if (!region || !region.isConnected) return;
  const container = mount;

  const lastWin = () =>
    computeWindow({
      itemCount: Number(region.dataset.vlTotal ?? 0),
      rowHeight: Number(region.dataset.vlRow ?? 80),
      scrollTop: container.scrollTop,
      viewportHeight: container.clientHeight || 480,
    });

  const paint = () => {
    const win = lastWin();
    region.dataset.vlStart = String(win.start);
    region.dataset.vlEnd = String(win.end);
    region.innerHTML = paintWindow(win);
  };

  liveLists.add({ root: region, paint });
  paint();
}
