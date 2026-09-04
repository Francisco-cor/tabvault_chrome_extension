// tests/lint/safeHtml.test.js — Regla custom tabvault/safe-html (Fase 10.3):
// sinks de HTML solo en módulos de UI + cero interpolación cruda de valores.

import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import { tabvaultPlugin } from '../../eslint.config.js';

/** @type {any} */ const rule = tabvaultPlugin.rules['safe-html'];

const tester = new RuleTester({
  languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
});

describe('tabvault/safe-html', () => {
  it('sink fuera de módulos de UI → error', () => {
    tester.run('sink-fuera', rule, {
      valid: [
        {
          filename: 'D:\\repo\\core\\domain.js',
          code: 'export function f(el) { el.textContent = "x"; }',
        },
      ],
      invalid: [
        {
          filename: 'D:\\repo\\core\\domain.js',
          code: 'export function f(el, html) { el.innerHTML = html; }',
          errors: [{ messageId: 'sink' }],
        },
        {
          filename: 'D:\\repo\\shared\\x.js',
          code: 'el.insertAdjacentHTML("beforeend", "<b>x</b>");',
          errors: [{ messageId: 'sink' }],
        },
      ],
    });
  });

  it('sink dentro de ui/components → permitido', () => {
    tester.run('sink-ok', rule, {
      valid: [
        {
          filename: 'D:\\repo\\ui\\components\\Card.js',
          code: 'export function paint(el, html) { el.innerHTML = html; }',
        },
      ],
      invalid: [],
    });
  });

  it('interpolación cruda de Identifier/Member → error; helpers y literales → ok', () => {
    tester.run('raw', rule, {
      valid: [
        {
          filename: 'D:\\repo\\ui\\views\\V.js',
          code: 'el.innerHTML = `<div>${escapeHtml(name)}</div>`;',
        },
        {
          filename: 'D:\\repo\\ui\\views\\V.js',
          code: 'el.innerHTML = `<div class="x-${i}" data-n="${rows.length}">${Icon("x")}</div>`;',
        },
        {
          filename: 'D:\\repo\\ui\\views\\V.js',
          code: 'el.innerHTML = `<span>${42}</span>`;',
        },
      ],
      invalid: [
        {
          filename: 'D:\\repo\\ui\\views\\V.js',
          code: 'el.innerHTML = `<div>${name}</div>`;',
          errors: [{ messageId: 'raw' }],
        },
        {
          filename: 'D:\\repo\\ui\\views\\V.js',
          code: 'el.innerHTML = `<a href="${tab.url}">x</a>`;',
          errors: [{ messageId: 'raw' }],
        },
      ],
    });
  });

  it('trustedNames de config pasan (fragmentos ya construidos con esc())', () => {
    tester.run('trusted', rule, {
      valid: [
        {
          filename: 'D:\\repo\\ui\\components\\H.js',
          code: 'el.innerHTML = `<div>${groupRows}${ungroupedRow}</div>`;',
          options: [{ trustedNames: ['groupRows', 'ungroupedRow'] }],
        },
      ],
      invalid: [
        {
          filename: 'D:\\repo\\ui\\components\\H.js',
          code: 'el.innerHTML = `<div>${otherRaw}</div>`;',
          options: [{ trustedNames: ['groupRows'] }],
          errors: [{ messageId: 'raw' }],
        },
      ],
    });
  });
});
