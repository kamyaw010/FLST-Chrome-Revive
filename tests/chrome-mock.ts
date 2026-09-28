/**
 * Chrome API mock for unit testing FLST Chrome extension.
 * Provides minimal mocks of chrome.tabs, chrome.windows, chrome.storage,
 * chrome.runtime, chrome.alarms, and chrome.action.
 */
/// <reference types="chrome" />

type Listener = (...args: any[]) => void;

class MockEvent {
  private listeners: Listener[] = [];
  addListener(fn: Listener) {
    this.listeners.push(fn);
  }
  removeListener(fn: Listener) {
    this.listeners = this.listeners.filter((l) => l !== fn);
  }
  hasListener(fn: Listener) {
    return this.listeners.includes(fn);
  }
  /** Fire the event with given args (for test use) */
  fire(...args: any[]) {
    for (const fn of this.listeners) {
      fn(...args);
    }
  }
  clear() {
    this.listeners = [];
  }
}

// --- Storage ---

let storageData: Record<string, any> = {};

const mockStorageLocal = {
  get: vi.fn((keys: string | string[] | Record<string, any> | null) => {
    if (typeof keys === "string") {
      return Promise.resolve({ [keys]: storageData[keys] });
    }
    if (Array.isArray(keys)) {
      const result: Record<string, any> = {};
      for (const k of keys) {
        if (k in storageData) result[k] = storageData[k];
      }
      return Promise.resolve(result);
    }
    return Promise.resolve({ ...storageData });
  }),
  set: vi.fn((items: Record<string, any>) => {
    Object.assign(storageData, items);
    return Promise.resolve();
  }),
  clear: vi.fn(() => {
    storageData = {};
    return Promise.resolve();
  }),
};

// --- Tabs ---

/** In-memory tab store for the mock */
let mockTabs: chrome.tabs.Tab[] = [];
let tabUpdateCalls: Array<{ tabId: number; props: any }> = [];
let tabMoveCalls: Array<{ tabId: number; props: any }> = [];

const mockTabsApi = {
  onCreated: new MockEvent(),
  onRemoved: new MockEvent(),
  onActivated: new MockEvent(),
  onAttached: new MockEvent(),
  onDetached: new MockEvent(),
  onReplaced: new MockEvent(),

  get: vi.fn((tabId: number, cb: (tab: any) => void) => {
    const tab = mockTabs.find((t) => t.id === tabId);
    if (!tab) {
      (chrome.runtime as any).lastError = { message: `No tab with id: ${tabId}` };
    } else {
      (chrome.runtime as any).lastError = undefined;
    }
    cb(tab ?? null);
  }),

  query: vi.fn((queryInfo: any, cb: (tabs: any[]) => void) => {
    let result = mockTabs;
    if (queryInfo.windowId !== undefined) {
      result = result.filter((t) => t.windowId === queryInfo.windowId);
    }
    (chrome.runtime as any).lastError = undefined;
    cb(result);
  }),

  update: vi.fn((tabId: number, props: any, cb?: (tab?: any) => void) => {
    tabUpdateCalls.push({ tabId, props });
    const tab = mockTabs.find((t) => t.id === tabId);
    (chrome.runtime as any).lastError = tab ? undefined : { message: `No tab with id: ${tabId}` };
    if (cb) cb(tab ?? null);
  }),

  move: vi.fn((tabId: number, props: any, cb?: (tab?: any) => void) => {
    tabMoveCalls.push({ tabId, props });
    (chrome.runtime as any).lastError = undefined;
    if (cb) cb({});
  }),

  create: vi.fn((_props: any, cb?: (tab?: any) => void) => {
    if (cb) cb({});
  }),
};

// --- Windows ---

let mockWindows: Array<{ id: number; type: string; tabs: any[] }> = [];

const mockWindowsApi = {
  onCreated: new MockEvent(),
  onRemoved: new MockEvent(),

  getAll: vi.fn((opts: any, cb: (windows: any[]) => void) => {
    (chrome.runtime as any).lastError = undefined;
    cb(mockWindows);
  }),

  get: vi.fn((windowId: number, opts: any, cb: (window: any) => void) => {
    const win = mockWindows.find((w) => w.id === windowId);
    (chrome.runtime as any).lastError = win
      ? undefined
      : { message: `No window with id: ${windowId}` };
    cb(win ?? null);
  }),
};

// --- Alarms ---

let mockAlarms: Record<string, { name: string; periodInMinutes?: number }> = {};
let mockContextMenus: Array<Record<string, any>> = [];

const mockAlarmsApi = {
  onAlarm: new MockEvent(),
  create: vi.fn((name: string, alarmInfo: any) => {
    mockAlarms[name] = { name, ...alarmInfo };
  }),
  get: vi.fn((name: string) => {
    return Promise.resolve(mockAlarms[name] ?? null);
  }),
  clear: vi.fn((name: string) => {
    delete mockAlarms[name];
    return Promise.resolve(true);
  }),
};

// --- Runtime ---

const mockRuntimeApi = {
  lastError: undefined as { message: string } | undefined,
  onStartup: new MockEvent(),
  onSuspend: new MockEvent(),
  onSuspendCanceled: new MockEvent(),
  onInstalled: new MockEvent(),
  onMessage: new MockEvent(),
  sendMessage: vi.fn(),
  openOptionsPage: vi.fn(() => Promise.resolve()),
  getManifest: vi.fn(() => ({ name: "FLST Chrome Revive", version: "3.4.1" })),
};

const mockI18nApi = {
  getUILanguage: vi.fn(() => "en-US"),
  getMessage: vi.fn((_name: string) => ""),
};

// --- Action ---

const mockActionApi = {
  onClicked: new MockEvent(),
};

// --- Context Menus ---

const mockContextMenusApi = {
  onClicked: new MockEvent(),
  create: vi.fn((properties: Record<string, any>, callback?: () => void) => {
    mockContextMenus.push({ ...properties });
    if (callback) callback();
    return properties.id;
  }),
  update: vi.fn((menuItemId: string, properties: Record<string, any>, callback?: () => void) => {
    const item = mockContextMenus.find((entry) => entry.id === menuItemId);
    if (item) {
      Object.assign(item, properties);
    }
    if (callback) callback();
  }),
  removeAll: vi.fn((callback?: () => void) => {
    mockContextMenus = [];
    if (callback) callback();
  }),
};

// === Assemble global chrome object ===

const chromeMock = {
  storage: { local: mockStorageLocal },
  tabs: mockTabsApi,
  windows: mockWindowsApi,
  alarms: mockAlarmsApi,
  runtime: mockRuntimeApi,
  i18n: mockI18nApi,
  action: mockActionApi,
  contextMenus: mockContextMenusApi,
};

(globalThis as any).chrome = chromeMock;

// === Test helpers exported for use in tests ===

export function resetChromeMock() {
  storageData = {};
  mockTabs = [];
  mockWindows = [];
  mockAlarms = {};
  mockContextMenus = [];
  tabUpdateCalls = [];
  tabMoveCalls = [];
  mockRuntimeApi.lastError = undefined;

  // Clear all mock call counts
  mockStorageLocal.get.mockClear();
  mockStorageLocal.set.mockClear();
  mockStorageLocal.clear.mockClear();
  mockTabsApi.get.mockClear();
  mockTabsApi.query.mockClear();
  mockTabsApi.update.mockClear();
  mockTabsApi.move.mockClear();
  mockTabsApi.create.mockClear();
  mockWindowsApi.getAll.mockClear();
  mockWindowsApi.get.mockClear();
  mockAlarmsApi.create.mockClear();
  mockAlarmsApi.get.mockClear();
  mockAlarmsApi.clear.mockClear();
  mockRuntimeApi.sendMessage.mockClear();
  mockRuntimeApi.openOptionsPage.mockClear();
  mockI18nApi.getUILanguage.mockClear();
  mockI18nApi.getMessage.mockClear();
  mockContextMenusApi.create.mockClear();
  mockContextMenusApi.update.mockClear();
  mockContextMenusApi.removeAll.mockClear();
}

export function setMockTabs(
  tabs: Array<{ id: number; windowId: number; active?: boolean; index?: number; pinned?: boolean }>,
) {
  mockTabs = tabs.map((t, i) => ({
    id: t.id,
    windowId: t.windowId,
    active: t.active ?? false,
    index: t.index ?? i,
    highlighted: false,
    pinned: t.pinned ?? false,
    incognito: false,
    selected: false,
    discarded: false,
    autoDiscardable: true,
    groupId: -1,
  })) as chrome.tabs.Tab[];
}

export function setMockWindows(
  windows: Array<{ id: number; type?: string; tabs: Array<{ id: number; active?: boolean }> }>,
) {
  mockWindows = windows.map((w) => ({
    id: w.id,
    type: w.type ?? "normal",
    tabs: w.tabs.map((t, i) => ({
      id: t.id,
      windowId: w.id,
      active: t.active ?? false,
      index: i,
    })),
  }));
  // Also update mockTabs flat list
  mockTabs = [];
  for (const w of mockWindows) {
    for (const t of w.tabs) {
      mockTabs.push({
        id: t.id,
        windowId: w.id,
        active: t.active ?? false,
        index: t.index ?? 0,
        highlighted: false,
        pinned: false,
        incognito: false,
        selected: false,
        discarded: false,
        autoDiscardable: true,
        groupId: -1,
      } as chrome.tabs.Tab);
    }
  }
}

export function getTabUpdateCalls() {
  return tabUpdateCalls;
}

export function getTabMoveCalls() {
  return tabMoveCalls;
}

export function getMockStorageData() {
  return storageData;
}

export function setMockStorageData(data: Record<string, any>) {
  storageData = { ...data };
}

export function getMockContextMenus() {
  return mockContextMenus;
}
