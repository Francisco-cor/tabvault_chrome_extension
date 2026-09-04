// @ts-nocheck — config de ESLint: ASTs sin tipar por diseño (la regla tiene sus
// propios tests en tests/lint/safeHtml.test.js).
import js from '@eslint/js';
import globals from 'globals';

// ─── Plugin local: tabvault/safe-html (Fase 10.3) ─────────────────────────────
// Dos garantías, alineadas con docs/security.md:
//  1. Los sinks de HTML (innerHTML/outerHTML/insertAdjacentHTML) solo pueden
//     existir en los módulos de construcción de UI — jamás en core/, shared/,
//     background/, popup/ o newtab/ fuera de su bootstrap.
//  2. Dentro de esos módulos, PROHIBIDA la interpolación cruda de valores en
//     plantillas HTML (`${session.name}`, `${tab.url}`): todo valor dinámico
//     debe pasar por un helper (escapeHtml/escapeAttr/safeHref/…) o por un
//     nombre confiable declarado (constantes numéricas/colores del sistema).
//     Las CALL expressions se consideran helpers por convención (revisión en PR).

const HTML_SINK_FILES = [
  'ui/render.js',
  'ui/main.js',
  'ui/components/',
  'ui/actions/',
  'ui/views/',
  'newtab/newtab.js',
];

/** @type {import('estree').Node|undefined} */
function unwrapParen(node) {
  let n = node;
  while (n && n.type === 'ParenthesizedExpression') n = n.expression;
  return n;
}

export const tabvaultPlugin = {
  rules: {
    'safe-html': {
      meta: {
        type: 'problem',
        docs: {
          description: 'HTML sinks solo en módulos de UI y sin interpolación cruda de valores (Fase 10.3)',
        },
        schema: [
          {
            type: 'object',
            properties: {
              allowedSinkFiles: { type: 'array', items: { type: 'string' } },
              trustedNames: { type: 'array', items: { type: 'string' } },
            },
            additionalProperties: false,
          },
        ],
        messages: {
          sink: 'Sink de HTML "{{name}}" prohibido aquí. Mueve la construcción de HTML a un módulo de UI ({{allowed}}) — docs/security.md',
          raw: 'Interpolación HTML cruda "${{text}}": envuelve en escapeHtml()/escapeAttr() o un helper de sanitización (docs/security.md)',
        },
      },
      create(context) {
        const opts = context.options[0] ?? {};
        const allowed = opts.allowedSinkFiles ?? HTML_SINK_FILES;
        const trusted = new Set([...DEFAULT_TRUSTED, ...(opts.trustedNames ?? [])]);
        const filename = String(context.filename ?? '').replace(/\\/g, '/');
        const sinkAllowed = allowed.some((p) => {
          const norm = p.replace(/\\/g, '/');
          return norm.endsWith('/') ? filename.includes(norm) : filename.endsWith(norm);
        });

        /**
         * ¿Expresión cruda (Identifier/Member) sin helper? Los literales
         * numéricos y booleanos son seguros por tipo.
         * @param {import('estree').Expression} expr
         */
        function rawInterpolation(expr) {
          const e = unwrapParen(expr);
          if (!e) return null;
          if (e.type === 'Identifier') return trusted.has(e.name) ? null : context.sourceCode.getText(e);
          if (e.type === 'MemberExpression') {
            const prop = /** @type {any} */ (e.property);
            const name = prop.type === 'Identifier' ? prop.name : context.sourceCode.getText(e);
            return trusted.has(name) ? null : context.sourceCode.getText(e);
          }
          return null; // llamadas y literales: convención helper / seguros
        }

        /** @param {import('estree').TemplateLiteral} tpl */
        function checkTemplate(tpl) {
          for (const expr of tpl.expressions) {
            const raw = rawInterpolation(expr);
            if (raw) {
              context.report({ node: expr, messageId: 'raw', data: { text: raw } });
            }
          }
        }

        /** @param {import('estree').Node} node @param {string} name @param {import('estree').Node|undefined} value */
        function checkSink(node, name, value) {
          if (!sinkAllowed) {
            context.report({ node, messageId: 'sink', data: { name, allowed: allowed.join(', ') } });
            return;
          }
          const v = unwrapParen(value ?? undefined);
          if (v && v.type === 'TemplateLiteral') checkTemplate(v);
        }

        return {
          AssignmentExpression(node) {
            if (node.operator !== '=') return;
            const left = unwrapParen(node.left);
            if (left?.type !== 'MemberExpression') return;
            const prop = /** @type {any} */ (left.property);
            if (prop.type !== 'Identifier') return;
            if (prop.name === 'innerHTML' || prop.name === 'outerHTML') {
              checkSink(node, prop.name, node.right);
            }
          },
          CallExpression(node) {
            const callee = unwrapParen(node.callee);
            if (callee?.type !== 'MemberExpression') return;
            const prop = /** @type {any} */ (callee.property);
            if (prop.type === 'Identifier' && prop.name === 'insertAdjacentHTML') {
              checkSink(node, 'insertAdjacentHTML', node.arguments[0]);
            }
          },
        };
      },
    },
  },
};

/** Nombres confiables del sistema actual (valores no-user-controlled):
 *  colores del design system, índices/contadores numéricos y atributos de
 *  tamaño. Mantener MÍNIMO; lo dinámico de usuario SIEMPRE pasa por esc(). */
const DEFAULT_TRUSTED = ['colorHex', 'tabIndex', 'size', 'hue', 'i', 'idx', 'index', 'n', 'count', 'length'];

export default [
  // Global ignores
  {
    ignores: ['node_modules/**', 'coverage/**', 'test-results/**', 'playwright-report/**'],
  },

  // Fase 10.3: sanitización HTML obligatoria (sinks + interpolación cruda)
  {
    files: [
      'popup/**/*.js',
      'background/**/*.js',
      'shared/**/*.js',
      'core/**/*.js',
      'ui/**/*.js',
      'newtab/**/*.js',
    ],
    plugins: { tabvault: tabvaultPlugin },
    rules: {
      'tabvault/safe-html': [
        'error',
        {
          // Identificadores que contienen HTML YA construido por helpers
          // (fragmentos internos armados con esc() en el propio módulo):
          //  - groupRows/ungroupedRow: HoverPreview.js arma filas con escapeHtml
          //    antes del sink. Ampliar SOLO con justificación en PR.
          trustedNames: ['groupRows', 'ungroupedRow'],
        },
      ],
    },
  },

  // Source + tests (browser extension context)
  {
    files: ['popup/**/*.js', 'background/**/*.js', 'shared/**/*.js', 'ui/**/*.js', 'tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.webextensions,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: true,
    },
    rules: {
      ...js.configs.recommended.rules,

      // Baseline pragmático (Fase 1): el código heredado aún no pasa estricto.
      // Estas reglas se endurecen al completar las Fases 2–4.
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true },
      ],
      eqeqeq: ['warn', 'smart'],
      'prefer-const': 'warn',
      complexity: ['warn', 12],
    },
  },

  // Scripts Node
  {
    files: ['**/*.cjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
  },

  // E2E (Playwright corre en Node)
  {
    files: ['tests/e2e/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  // Scripts Node ESM (.mjs)
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
  },

  // Config JS del propio repo
  {
    files: ['eslint.config.js', 'vitest.config.js', 'playwright.config.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
  },
];
