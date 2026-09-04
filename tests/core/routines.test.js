// tests/core/routines.test.js — Rutinas puras (Fase 9.4): validación, próxima
// ejecución, orden y nombres de alarma. Cubre el módulo sin chrome.*.

import { describe, it, expect } from 'vitest';
import {
  isValidTime,
  normalizeRoutine,
  nextRunAt,
  sortedRoutines,
  alarmNameFor,
  isRoutineAlarm,
  routineIdFromAlarm,
} from '../../core/routines.js';

describe('isValidTime', () => {
  it('acepta HH:MM 24h válidos', () => {
    expect(isValidTime('00:00')).toBe(true);
    expect(isValidTime('09:05')).toBe(true);
    expect(isValidTime('23:59')).toBe(true);
  });

  it('rechaza inválidos', () => {
    expect(isValidTime('24:00')).toBe(false);
    expect(isValidTime('9:00')).toBe(false);
    expect(isValidTime('09:60')).toBe(false);
    expect(isValidTime('0900')).toBe(false);
    expect(isValidTime('')).toBe(false);
    expect(isValidTime(null)).toBe(false);
    expect(isValidTime(9)).toBe(false);
  });
});

describe('normalizeRoutine', () => {
  const base = { id: 'r1', sessionId: 's1', time: '09:00' };

  it('normaliza con defaults (enabled=true, created=now)', () => {
    const out = normalizeRoutine(base);
    expect(out).toMatchObject({ id: 'r1', sessionId: 's1', time: '09:00', enabled: true });
    expect(typeof (/** @type {any} */ (out)?.created)).toBe('number');
  });

  it('enabled=false explícito se respeta; created numérico se conserva', () => {
    expect(normalizeRoutine({ ...base, enabled: false })?.enabled).toBe(false);
    expect(normalizeRoutine({ ...base, created: 123 })?.created).toBe(123);
  });

  it('null para entradas inválidas', () => {
    expect(normalizeRoutine(null)).toBeNull();
    expect(normalizeRoutine('x')).toBeNull();
    expect(normalizeRoutine({ ...base, id: '' })).toBeNull();
    expect(normalizeRoutine({ ...base, sessionId: '' })).toBeNull();
    expect(normalizeRoutine({ ...base, time: '25:00' })).toBeNull();
  });
});

describe('nextRunAt', () => {
  const now = new Date('2026-08-24T10:00:00').getTime();

  it('hoy si aún no llegó', () => {
    const out = nextRunAt('10:30', now);
    expect(new Date(out).getDate()).toBe(new Date(now).getDate());
    expect(out).toBeGreaterThan(now);
  });

  it('mañana si la hora ya pasó', () => {
    const out = nextRunAt('09:00', now);
    expect(new Date(out).getDate()).toBe(new Date(now).getDate() + 1);
  });

  it('exactamente ahora → mañana (siempre futuro estricto)', () => {
    expect(nextRunAt('10:00', now)).toBeGreaterThan(now);
  });
});

describe('sortedRoutines', () => {
  it('ordena por próxima ejecución asc (in-place no muta)', () => {
    const now = new Date('2026-08-24T10:00:00').getTime();
    /** @param {string} id @param {string} time @returns {any} */
    const mk = (id, time) => ({ id, sessionId: 's', time, enabled: true, created: 1 });
    // soon: hoy 10:30 · late: HOY 23:00 (aún no pasó) · early: mañana 01:00
    const list = [mk('late', '23:00'), mk('early', '01:00'), mk('soon', '10:30')];
    const sorted = sortedRoutines(list, now);
    expect(sorted.map((r) => r.id)).toEqual(['soon', 'late', 'early']);
    expect(list[0].id).toBe('late'); // original intacto
  });
});

describe('alarmas', () => {
  it('alarmNameFor / isRoutineAlarm / routineIdFromAlarm round-trip', () => {
    const name = alarmNameFor('abc');
    expect(name).toBe('tabvault-routine-abc');
    expect(isRoutineAlarm(name)).toBe(true);
    expect(routineIdFromAlarm(name)).toBe('abc');
    expect(isRoutineAlarm('tabvault-badge-clear')).toBe(false);
    expect(routineIdFromAlarm('otra')).toBeNull();
    expect(routineIdFromAlarm('tabvault-routine-')).toBeNull();
  });
});
