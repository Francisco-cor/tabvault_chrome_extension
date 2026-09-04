// tests/ui/theme.test.js — Lógica pura de Fase 5: temas/acento, reloj de 60s,
// onboarding y timestamps relativos con reloj inyectable.

import { describe, it, expect } from 'vitest';
import { resolveTheme } from '../../ui/actions/settingsActions.js';
import { shouldShowOnboarding } from '../../ui/components/Onboarding.js';
import { createStore } from '../../ui/store.js';
import { rootReducer, initialState } from '../../ui/reducers.js';
import { A } from '../../ui/actions.js';
import { SessionsView } from '../../ui/views/SessionsView.js';
import { makeSession } from '../fixtures/sessions.js';
import { formatRelativeTime } from '../../shared/utils.js';

describe('resolveTheme (Fase 5.4)', () => {
  it("'system' se resuelve contra prefers-color-scheme", () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  it("temas explícitos pasan through y desconocidos caen a 'dark'", () => {
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme(/** @type {any} */ ('solarized'), true)).toBe('dark');
    expect(resolveTheme(/** @type {any} */ (undefined), false)).toBe('dark');
  });
});

describe('shouldShowOnboarding (Fase 5.4)', () => {
  it('true solo si no hay settings o el flag no está en true', () => {
    expect(shouldShowOnboarding(null)).toBe(true);
    expect(shouldShowOnboarding(undefined)).toBe(true);
    expect(shouldShowOnboarding({})).toBe(true);
    expect(shouldShowOnboarding({ onboardingDone: false })).toBe(true);
    expect(shouldShowOnboarding({ onboardingDone: true })).toBe(false);
  });
});

describe('TICKED — timestamps relativos auto-refrescantes', () => {
  it('el reloj avanza sin tocar sesiones ni borradores', () => {
    const store = createStore(rootReducer, initialState());
    const before = store.getState();
    store.dispatch({ type: A.TICKED, now: before.now + 60_000 });
    const after = store.getState();
    expect(after.now).toBe(before.now + 60_000);
    expect(after.sessions).toEqual({});
    expect(after.notes).toEqual({});
  });

  it('la firma de deps de SessionsView cambia al cambiar el minuto', () => {
    const store = createStore(rootReducer, initialState());
    store.dispatch({
      type: A.APP_READY,
      sessions: { a: makeSession({ id: 'a', updated: Date.now() }) },
      trash: {},
      settings: { theme: 'dark', sortBy: 'newest' },
      liveGroups: [],
      liveUngrouped: [],
    });
    const s1 = store.getState();
    const d1 = SessionsView.deps(s1);
    // Mismo minuto → misma firma (no repinta)
    expect(JSON.stringify(d1)).toBe(JSON.stringify(SessionsView.deps({ ...s1, now: s1.now + 1000 })));
    // Minuto siguiente → firma distinta (repinta y refresca "2m ago")
    expect(JSON.stringify(d1)).not.toBe(JSON.stringify(SessionsView.deps({ ...s1, now: s1.now + 61_000 })));
  });
});

describe('formatRelativeTime con reloj inyectable', () => {
  it('respeta el now dado (puro, testeable)', () => {
    const now = Date.UTC(2026, 0, 15, 12, 0, 0);
    expect(formatRelativeTime(now - 30_000, now)).toBe('just now');
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5m ago');
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(formatRelativeTime(now - 2 * 86_400_000, now)).toBe('2d ago');
  });

  it('sin now sigue funcionando (compatibilidad)', () => {
    expect(typeof formatRelativeTime(Date.now() - 120_000)).toBe('string');
  });
});
