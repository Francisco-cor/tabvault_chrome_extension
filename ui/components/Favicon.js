// ui/components/Favicon.js — Render del favicon con cadena de fallback (Fase 10.2).
//
//   1. Store LRU por dominio (chrome.storage.local.favicons) — offline, privado.
//   2. chrome://favicon2 (si Chrome lo sirve; requiere permiso "favicon").
//   3. Identicon determinista: letra inicial + tono HSL hash del dominio.
//
// Las capas 1-2 son <img> posicionadas sobre el identicon: si fallan
// (sin dato, sin permiso, sin red) se auto-eliminan vía onerror y el
// identicon queda visible. Sin JS en runtime, seguro por construcción.

import { escapeAttr, escapeHtml } from '../render.js';
import { domainOf, getFaviconFor, identiconFor } from '../../core/favicons.js';

/**
 * URL de la capa chrome://favicon2 para una página ('' si no aplica).
 * @param {string} url
 */
function favicon2Url(url) {
  if (!url || !/^(https?|file):/.test(url)) return '';
  try {
    return `chrome://favicon2/?size=16&scale_factor=1x&page_url=${encodeURIComponent(url)}`;
  } catch {
    return '';
  }
}

/**
 * HTML del favicon para una URL dentro de un contenedor flex.
 * @param {unknown} url URL de la tab/página
 * @param {any} favicons estado del store LRU (state.favicons)
 * @param {{ size?: number }} [opts]
 * @returns {string}
 */
export function favIconHtml(url, favicons, { size = 13 } = {}) {
  const u = typeof url === 'string' ? url : '';
  const domain = domainOf(u);
  const stored = getFaviconFor(favicons, u);
  const layer = stored || favicon2Url(u);
  const { letter, hue } = identiconFor(u);

  const img =
    layer && domain
      ? `<img class="tab-favicon" src="${escapeAttr(layer)}" alt="" onerror="this.remove()">`
      : '';

  return `<span class="fav-wrap" style="width:${size}px;height:${size}px;--fav-hue:${hue}" title="${escapeAttr(domain)}"><span class="fav-letter">${escapeHtml(letter)}</span>${img}</span>`;
}
