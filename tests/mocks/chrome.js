// tests/mocks/chrome.js — Mock del namespace chrome para Vitest (node env).
// Cobertura: storage local/sync/session + onChanged, windows, tabs, tabGroups,
// alarms, action (badge), contextMenus y registros de eventos runtime/commands.
// Semántica mínima pero fiel: ids numéricos auto-incrementales, clones en
// lecturas (aislación estructural como chrome real) y eventos disparables.
import { vi } from 'vitest';

/** Handle devuelto por installChromeMock. @typedef {ReturnType<typeof installChromeMock>} ChromeMockHandle */

/**
 * Crea un mock de chrome.* con almacenamiento en memoria y modelo de ventanas.
 * @returns {any} handle con chrome, estado interno, dumpLocal, reset y helpers de eventos
 */
export function createChromeMock() {
  /** @type {Map<string, unknown>} */
  const local = new Map();
  /** @type {Map<string, unknown>} */
  const sync = new Map();
  /** @type {Map<string, unknown>} */
  const session = new Map();
  /** @type {((changes: any, area: string) => void)[]} */
  const onChangedListeners = [];

  /**
   * @param {Map<string, unknown>} map
   * @param {number} quotaBytes
   */
  const makeArea = (map, quotaBytes) => ({
    QUOTA_BYTES: quotaBytes,
    /** @param {string|string[]|Record<string, unknown>|null} keys */
    async get(keys) {
      if (keys === null || keys === undefined) {
        return Object.fromEntries(map);
      }
      if (typeof keys === 'string') {
        return map.has(keys) ? { [keys]: structuredClone(map.get(keys)) } : {};
      }
      if (Array.isArray(keys)) {
        /** @type {Record<string, unknown>} */
        const out = {};
        for (const k of keys) if (map.has(k)) out[k] = structuredClone(map.get(k));
        return out;
      }
      // objeto con defaults
      /** @type {Record<string, unknown>} */
      const out = {};
      for (const [k, def] of Object.entries(keys)) {
        out[k] = map.has(k) ? structuredClone(map.get(k)) : def;
      }
      return out;
    },
    /** @param {Record<string, unknown>} obj */
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) map.set(k, structuredClone(v));
      emit({
        areaName: map === local ? 'local' : map === sync ? 'sync' : 'session',
        changes: snapshotChanges(obj),
      });
    },
    /** @param {string|string[]} keys */
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) map.delete(k);
    },
    async clear() {
      map.clear();
    },
    /** @param {unknown} _keys */
    async getBytesInUse(_keys) {
      return JSON.stringify(Object.fromEntries(map)).length;
    },
    /** Nivel de acceso (no-op en el mock). */
    setAccessLevel() {},
  });

  /** @param {Record<string, unknown>} obj */
  function snapshotChanges(obj) {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = { oldValue: undefined, newValue: structuredClone(v) };
    }
    return out;
  }

  /** @param {{ changes: unknown, areaName: string }} evt */
  function emit(evt) {
    for (const fn of onChangedListeners) fn(evt.changes, evt.areaName);
  }

  // ─── Modelo de ventanas/tabs/grupos ──────────────────────────────────────────
  let nextId = 100;

  /** @type {any[]} */
  const wins = [];
  /** @type {any[]} */
  const tabs = [];
  /** @type {any[]} */
  const groups = [];

  /** @param {Record<string, any>} [winProps] */
  const makeWindow = (winProps = {}) => ({
    id: ++nextId,
    incognito: false,
    focused: false,
    ...winProps,
  });

  /** @param {any} x */
  const clone = (x) => (x == null ? x : structuredClone(x));

  /** @param {number} id */
  const findWin = (id) => wins.find((w) => w.id === id);

  /** @param {{ populate?: boolean }} [q] */
  const queryWins = (q = {}) =>
    q.populate ? wins.map((w) => ({ ...clone(w), tabs: tabsOf(w.id).map(clone) })) : wins.map(clone);

  /** @param {number} winId */
  const tabsOf = (winId) => tabs.filter((t) => t.windowId === winId);

  /** @type {any[]} */
  const alarms = [];
  /** @type {any} */
  const badgeState = { text: '', color: '' };

  const chrome = {
    storage: {
      local: makeArea(local, 10_485_760),
      sync: makeArea(sync, 102_400),
      session: makeArea(session, 10_485_760),
      onChanged: {
        /** @param {(changes: any, area: string) => void} fn */
        addListener(fn) {
          onChangedListeners.push(fn);
        },
        /** @param {(changes: any, area: string) => void} fn */
        removeListener(fn) {
          const i = onChangedListeners.indexOf(fn);
          if (i !== -1) onChangedListeners.splice(i, 1);
        },
      },
    },

    windows: {
      /** @param {{ populate?: boolean }} [q] */
      async getAll(q = {}) {
        return queryWins(q);
      },
      /** @param {number} id */
      async get(id) {
        const w = findWin(id);
        if (!w) throw new Error(`No window with id: ${id}`);
        return clone(w);
      },
      async getLastFocused() {
        const w = [...wins].reverse().find((x) => x.focused) ?? wins[wins.length - 1];
        if (!w) throw new Error('No last-focused window');
        return clone(w);
      },
      async getCurrent() {
        return this.getLastFocused();
      },
      /** @param {{ url?: string, incognito?: boolean }} props */
      async create(props = {}) {
        const win = makeWindow({ focused: true, incognito: !!props.incognito });
        for (const other of wins) other.focused = false;
        wins.push(win);
        if (props.url) {
          await chrome.tabs.create({ windowId: win.id, url: props.url });
        }
        return clone(win);
      },
      /** @param {number} id */
      async remove(id) {
        const idx = wins.findIndex((w) => w.id === id);
        if (idx === -1) throw new Error(`No window with id: ${id}`);
        wins.splice(idx, 1);
        for (let i = tabs.length - 1; i >= 0; i--) if (tabs[i].windowId === id) tabs.splice(i, 1);
        for (let i = groups.length - 1; i >= 0; i--) if (groups[i].windowId === id) groups.splice(i, 1);
        fire.windows.onRemoved(id);
      },
      onCreated: registry(),
      onRemoved: registry(),
    },

    tabs: {
      /** @param {{ windowId?: number, currentWindow?: boolean }} q */
      async query(q = {}) {
        if (q.windowId != null) return tabsOf(q.windowId).map(clone);
        return tabs.map(clone);
      },
      /** @param {number} id */
      async get(id) {
        const tab = tabs.find((t) => t.id === id);
        if (!tab) throw new Error(`No tab with id: ${id}`);
        return clone(tab);
      },
      /** @param {{ windowId?: number, url?: string, pinned?: boolean, index?: number }} props */
      async create(props = {}) {
        const tab = {
          id: ++nextId,
          windowId: props.windowId ?? wins[0]?.id,
          url: props.url ?? 'about:blank',
          title: props.url ?? 'about:blank',
          favIconUrl: '',
          groupId: -1,
          pinned: !!props.pinned,
          active: false,
          status: 'complete',
        };
        tabs.push(tab);
        fire.tabs.onCreated(clone(tab));
        return clone(tab);
      },
      /** @param {number} id @param {Record<string, unknown>} props */
      async update(id, props) {
        const tab = tabs.find((t) => t.id === id);
        if (!tab) throw new Error(`No tab with id: ${id}`);
        Object.assign(tab, props);
        fire.tabs.onUpdated(id, {}, clone(tab));
        return clone(tab);
      },
      /** @param {number|number[]} id */
      async remove(id) {
        const ids = Array.isArray(id) ? id : [id];
        for (const tid of ids) {
          const idx = tabs.findIndex((t) => t.id === tid);
          if (idx === -1) throw new Error(`No tab with id: ${tid}`);
          const [gone] = tabs.splice(idx, 1);
          fire.tabs.onRemoved(tid, { windowId: gone.windowId, isWindowClosing: false });
        }
      },
      /** @param {{ tabIds: number[], createProperties?: { windowId?: number } }} p */
      async group(p) {
        if (!Array.isArray(p.tabIds) || p.tabIds.length === 0) throw new Error('tabIds required');
        const groupId = ++nextId;
        const windowId = p.createProperties?.windowId ?? tabs.find((t) => t.id === p.tabIds[0])?.windowId;
        for (const tid of p.tabIds) {
          const tab = tabs.find((t) => t.id === tid);
          if (tab) tab.groupId = groupId;
        }
        groups.push({ id: groupId, windowId, title: '', color: 'grey' });
        return groupId;
      },
      onCreated: registry(),
      onUpdated: registry(),
      onRemoved: registry(),
      onMoved: registry(),
    },

    tabGroups: {
      /** @param {{ windowId?: number }} q */
      async query(q = {}) {
        if (q.windowId != null) return groups.filter((g) => g.windowId === q.windowId).map(clone);
        return groups.map(clone);
      },
      /** @param {number} id @param {Record<string, unknown>} props */
      async update(id, props) {
        const g = groups.find((x) => x.id === id);
        if (!g) throw new Error(`No tab group with id: ${id}`);
        Object.assign(g, props);
        return clone(g);
      },
    },

    alarms: {
      /** @param {string} name @param {Record<string, unknown>} info */
      create(name, info) {
        const i = alarms.findIndex((a) => a.name === name);
        const alarm = { name, ...info };
        if (i !== -1) alarms[i] = alarm;
        else alarms.push(alarm);
      },
      /** @param {string} name */
      async clear(name) {
        const i = alarms.findIndex((a) => a.name === name);
        if (i !== -1) alarms.splice(i, 1);
      },
      async getAll() {
        return clone(alarms);
      },
      onAlarm: registry(),
    },

    action: {
      /** @param {{ text: string }} p */
      setBadgeText(p) {
        badgeState.text = p.text;
      },
      /** @param {{ color: string }} p */
      setBadgeBackgroundColor(p) {
        badgeState.color = p.color;
      },
      openPopup: undefined, // se activa manualmente en tests que lo necesiten
    },

    contextMenus: {
      /** @type {any[]} */
      createdDefs: [],
      removeAll(/** @type {() => void} */ cb) {
        this.createdDefs.length = 0;
        cb?.();
      },
      /** @param {Record<string, unknown>} def @param {() => void} [cb] */
      create(def, cb) {
        this.createdDefs.push(clone(def));
        cb?.();
      },
      onClicked: registry(),
    },

    runtime: {
      /** @param {string} path */
      getURL(path) {
        return `chrome-extension://tabvault-test/${path}`;
      },
      onInstalled: registry(),
      onStartup: registry(),
      onMessage: registry(),
    },

    commands: {
      onCommand: registry(),
    },
  };

  /** Registro de listeners con disparador manual. */
  function registry() {
    /** @type {((...args: any[]) => void)[]} */
    const listeners = [];
    const api = {
      /** @param {(...args: any[]) => void} fn */
      addListener(fn) {
        listeners.push(fn);
      },
      /** @param {(...args: any[]) => void} fn */
      removeListener(fn) {
        const i = listeners.indexOf(fn);
        if (i !== -1) listeners.splice(i, 1);
      },
      _listeners: listeners,
    };
    return api;
  }

  /** @param {...any} args */
  const fireTabUpdated = (...args) => chrome.tabs.onUpdated._listeners.forEach((fn) => fn(...args));

  /** Dispara eventos registrados. @type {any} */
  const fire = {
    windows: {
      onRemoved: (/** @type {number} */ id) => chrome.windows.onRemoved._listeners.forEach((fn) => fn(id)),
    },
    tabs: {
      onCreated: (/** @type {any} */ tab) => chrome.tabs.onCreated._listeners.forEach((fn) => fn(clone(tab))),
      onUpdated: (/** @type {...any} */ ...args) => fireTabUpdated(...args),
      onRemoved: (/** @type {number} */ tabId, /** @type {any} */ info) =>
        chrome.tabs.onRemoved._listeners.forEach((fn) => fn(tabId, info)),
      onMoved: (/** @type {number} */ tabId, /** @type {any} */ info) =>
        chrome.tabs.onMoved._listeners.forEach((fn) => fn(tabId, info)),
    },
    alarms: (/** @type {any} */ alarm) => chrome.alarms.onAlarm._listeners.forEach((fn) => fn(alarm)),
    contextMenus: (/** @type {any} */ info) =>
      chrome.contextMenus.onClicked._listeners.forEach((fn) => fn(info, undefined)),
  };

  return {
    chrome,
    fire,
    badgeState,
    alarms,
    /** Estado interno para asserts: ventanas/tabs/grupos vivos. */
    model: {
      get wins() {
        return wins;
      },
      get tabs() {
        return tabs;
      },
      get groups() {
        return groups;
      },
    },
    dumpLocal: () => Object.fromEntries(local),
    dumpSession: () => Object.fromEntries(session),
    /**
     * Siembra una ventana con tabs crudas.
     * @param {Record<string, any>} [winProps]
     * @param {Record<string, any>[]} [tabProps]
     * @returns {number} winId
     */
    seedWindow(winProps = {}, tabProps = []) {
      const win = makeWindow(winProps);
      wins.push(win);
      for (const tp of tabProps) {
        tabs.push({
          id: ++nextId,
          windowId: win.id,
          url: 'https://example.com/',
          title: '',
          favIconUrl: '',
          groupId: -1,
          pinned: false,
          active: false,
          status: 'complete',
          ...tp,
        });
      }
      return win.id;
    },
    /** Registra un grupo nativo. @param {number} windowId @param {number} nativeId @param {string} title @param {string} color @returns {number} nativeGroupId */
    seedGroup(windowId, nativeId, title, color) {
      groups.push({ id: nativeId, windowId, title, color });
      return nativeId;
    },
    reset: () => {
      local.clear();
      sync.clear();
      session.clear();
      wins.length = 0;
      tabs.length = 0;
      groups.length = 0;
      alarms.length = 0;
      nextId = 100;
    },
  };
}

/** Instala el mock como global `chrome` y devuelve utilidades. */
export function installChromeMock() {
  const handle = createChromeMock();
  vi.stubGlobal('chrome', handle.chrome);
  return { ...handle, unmock: () => vi.unstubAllGlobals() };
}
