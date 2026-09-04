// tests/background/routinesHandler.test.js — Orquestación de rutinas (Fase 9.4):
// scheduleAllRoutines (crear/limpiar alarms), handleRoutineAlarm (re-programa
// para mañana + notificación o restore) y clicks de notificación.

import { describe, it, expect, beforeEach } from 'vitest';
import { installChromeMock } from '../mocks/chrome.js';
import { repository as repo } from '../../core/repository.js';
import {
  scheduleAllRoutines,
  handleRoutineAlarm,
  handleRoutineNotificationClick,
} from '../../background/handlers/routines.js';
import { alarmNameFor } from '../../core/routines.js';

/** @type {ReturnType<typeof installChromeMock>} */
let h;

/** Añade notifications al mock (create/clear con registro). @param {any} handle @returns {any[]} */
function withNotifications(handle) {
  /** @type {any[]} */
  const created = [];
  handle.chrome.notifications = {
    created,
    /** @param {string} id @param {any} opts @param {() => void} [cb] */
    create(id, opts, cb) {
      created.push({ id, opts });
      cb?.();
    },
    /** @param {string} id @param {() => void} [cb] */
    clear(id, cb) {
      const i = created.findIndex((c) => c.id === id);
      if (i !== -1) created.splice(i, 1);
      cb?.();
    },
  };
  return created;
}

/** Semilla: 1 sesión + 1 rutina habilitada a las 09:00. */
async function seedRoutine(time = '09:00', enabled = true) {
  await repo.saveSession({
    id: 'sess1',
    name: 'Matutina',
    created: 1,
    updated: 1,
    groups: [],
    ungroupedTabs: [],
    metadata: { groupCount: 0, tabCount: 0 },
  });
  await repo.saveRoutine({ id: 'r1', sessionId: 'sess1', time, enabled });
}

beforeEach(() => {
  h = installChromeMock();
  h.reset();
  repo.invalidate();
});

describe('scheduleAllRoutines', () => {
  it('crea alarm con when=nextRunAt para rutinas habilitadas', async () => {
    await seedRoutine('09:00', true);
    await scheduleAllRoutines();
    const alarms = await h.chrome.alarms.getAll();
    const alarm = alarms.find((/** @type {any} */ a) => a.name === alarmNameFor('r1'));
    expect(alarm).toBeTruthy();
    expect(alarm.when).toBeGreaterThan(Date.now() - 1000);
  });

  it('limpia alarms huérfanas y de rutinas deshabilitadas', async () => {
    await seedRoutine('09:00', false);
    h.chrome.alarms.create(alarmNameFor('r1'), { when: Date.now() + 1 });
    h.chrome.alarms.create(alarmNameFor('fantasma'), { when: Date.now() + 1 });
    await scheduleAllRoutines();
    const names = (await h.chrome.alarms.getAll()).map((/** @type {any} */ a) => a.name);
    expect(names).not.toContain(alarmNameFor('r1'));
    expect(names).not.toContain(alarmNameFor('fantasma'));
  });
});

describe('handleRoutineAlarm', () => {
  it('no-routine alarm → false (no consumida)', async () => {
    expect(await handleRoutineAlarm({ name: 'tabvault-badge-clear' })).toBe(false);
  });

  it('rutina válida → re-programa mañana + notificación con botones', async () => {
    const created = withNotifications(h);
    await seedRoutine('09:00', true);

    const consumed = await handleRoutineAlarm({ name: alarmNameFor('r1') });
    expect(consumed).toBe(true);

    // re-programada inmediatamente (periodicidad garantizada)
    const alarms = await h.chrome.alarms.getAll();
    expect(alarms.find((/** @type {any} */ a) => a.name === alarmNameFor('r1'))).toBeTruthy();

    expect(created.length).toBe(1);
    expect(created[0].id).toBe('tabvault-routine-r1');
    expect(created[0].opts.buttons?.length).toBe(2);
  });

  it('sin notifications → fallback restore directo', async () => {
    await seedRoutine('09:00', true);
    // (el mock no define chrome.notifications)
    const consumed = await handleRoutineAlarm({ name: alarmNameFor('r1') });
    expect(consumed).toBe(true);
    // la sesión sigue existiendo; sin excepción
    expect(await repo.getSession('sess1')).toBeTruthy();
  });

  it('rutina inexistente o sesión borrada → consumida sin lanzar', async () => {
    withNotifications(h);
    expect(await handleRoutineAlarm({ name: alarmNameFor('ghost') })).toBe(true);
    await seedRoutine('09:00', true);
    await repo.deleteSession('sess1');
    expect(await handleRoutineAlarm({ name: alarmNameFor('r1') })).toBe(true);
  });
});

describe('handleRoutineNotificationClick', () => {
  it('id ajeno → false; botón 0 → restore new; botón 1 → incógnito', async () => {
    withNotifications(h);
    await seedRoutine('09:00', true);

    expect(await handleRoutineNotificationClick('otra-notificacion')).toBe(false);

    const ok = await handleRoutineNotificationClick('tabvault-routine-r1', 0);
    expect(ok).toBe(true);

    const ok2 = await handleRoutineNotificationClick('tabvault-routine-r1', 1);
    expect(ok2).toBe(true);

    // la notificación se limpió
    expect(h.chrome.notifications.created.length).toBe(0);
  });
});
