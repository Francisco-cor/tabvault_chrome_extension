// background/handlers/routines.js — Rutinas programadas (Fase 9.4).
// Orquesta alarms diarias por rutina y notificaciones con acciones.

import { repository as repo } from '../../core/repository.js';
import { nextRunAt, alarmNameFor, isRoutineAlarm, routineIdFromAlarm } from '../../core/routines.js';
import { restoreSessionById } from './restore.js';

const NOTIF_PREFIX = 'tabvault-routine-';

/**
 * (Re)programa todas las alarms de rutinas habilitadas.
 * Debe llamarse tras boot, onInstalled, startup y cambios de storage.
 */
export async function scheduleAllRoutines() {
  try {
    const routines = await repo.getRoutines();
    // Limpiar alarms huérfanas primero
    const all = await chrome.alarms.getAll();
    for (const a of all) {
      if (isRoutineAlarm(a.name) && !routines.some((r) => alarmNameFor(r.id) === a.name && r.enabled)) {
        await chrome.alarms.clear(a.name);
      }
    }
    for (const r of routines) {
      if (!r.enabled) {
        await chrome.alarms.clear(alarmNameFor(r.id));
        continue;
      }
      const when = nextRunAt(r.time, Date.now());
      chrome.alarms.create(alarmNameFor(r.id), { when });
    }
  } catch (e) {
    console.error('[TabVault] scheduleAllRoutines failed', e);
  }
}

/**
 * Maneja la alarma de rutina disparada.
 * @param {{ name: string }} alarm
 * @returns {Promise<boolean>} true si la alarma era de rutina
 */
export async function handleRoutineAlarm(alarm) {
  if (!isRoutineAlarm(alarm.name)) return false;
  const routineId = routineIdFromAlarm(alarm.name);
  if (!routineId) return true;

  try {
    const routines = await repo.getRoutines();
    const routine = routines.find((r) => r.id === routineId);
    if (!routine || !routine.enabled) return true;

    // Re-programar para mañana antes de cualquier otra cosa (garantiza periodicidad)
    const next = nextRunAt(routine.time, Date.now());
    chrome.alarms.create(alarm.name, { when: next });

    const sessions = await repo.getSessions();
    const session = sessions[routine.sessionId];
    if (!session) {
      console.warn('[TabVault] routine session missing', routine.sessionId);
      return true;
    }

    // Notificación opcional si el permiso existe; fallback: abrir directo
    const canNotify = typeof chrome.notifications !== 'undefined' && chrome.notifications.create;
    if (canNotify) {
      await new Promise((resolve) => {
        chrome.notifications.create(
          `${NOTIF_PREFIX}${routineId}`,
          {
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icons/icon128.png'),
            title: `Rutina: ${session.name}`,
            message: `¿Abrir tu rutina de las ${routine.time}?`,
            buttons: [{ title: 'Abrir' }, { title: 'Incógnito' }],
            requireInteraction: true,
          },
          () => resolve(undefined)
        );
      });
      // El click se maneja en onClicked/onButtonClicked registrados en sw-main
    } else {
      await restoreSessionById(routine.sessionId, { mode: 'new' });
    }
  } catch (e) {
    console.error('[TabVault] routine alarm failed', e);
  }
  return true;
}

/**
 * Click en notificación de rutina.
 * @param {string} notificationId
 * @param {number} [buttonIndex] 0=Abrir 1=Incógnito, undefined=click cuerpo
 */
export async function handleRoutineNotificationClick(notificationId, buttonIndex) {
  if (!notificationId.startsWith(NOTIF_PREFIX)) return false;
  const routineId = notificationId.slice(NOTIF_PREFIX.length);
  try {
    const routines = await repo.getRoutines();
    const routine = routines.find((r) => r.id === routineId);
    if (!routine) return true;
    if (buttonIndex === 1) {
      await restoreSessionById(routine.sessionId, { mode: 'incognito' });
    } else if (buttonIndex === 0 || buttonIndex === undefined) {
      await restoreSessionById(routine.sessionId, { mode: 'new' });
    }
    // Ignorar = buttonIndex ??? chrome no envía evento para cerrar sin botón
    chrome.notifications.clear(notificationId);
  } catch (e) {
    console.error('[TabVault] routine notification click failed', e);
  }
  return true;
}

/**
 * Handler para storage.onChanged de routines → re-programar.
 * @param {Record<string, any>} changes
 * @param {string} area
 */
export function onRoutinesChanged(changes, area) {
  if (area !== 'local' || !('routines' in changes)) return;
  void scheduleAllRoutines();
}
