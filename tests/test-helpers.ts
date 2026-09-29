/**
 * Helper to create fresh manager instances for testing.
 * Bypasses singletons by resetting the static instance field.
 */
import { TabManager } from "../src/managers/tab-manager";
import { SettingsManager } from "../src/managers/settings-manager";
import { StorageManager } from "../src/managers/storage-manager";
import { ServiceWorkerManager } from "../src/managers/service-worker-manager";
import { WindowManager } from "../src/managers/window-manager";
import type { TabTracker, TabMRUEntry, TabInfo } from "../src/types";

/**
 * Reset a singleton class by clearing its static instance.
 */
function resetSingleton(cls: any) {
  // All managers store instance in a private static field called 'instance'
  cls.instance = undefined;
}

export function createFreshTabManager(): TabManager {
  resetSingleton(TabManager);
  return TabManager.getInstance();
}

export function createFreshSettingsManager(): SettingsManager {
  resetSingleton(SettingsManager);
  return SettingsManager.getInstance();
}

export function createFreshStorageManager(): StorageManager {
  resetSingleton(StorageManager);
  return StorageManager.getInstance();
}

export function createFreshServiceWorkerManager(): ServiceWorkerManager {
  resetSingleton(ServiceWorkerManager);
  return ServiceWorkerManager.getInstance();
}

export function createFreshWindowManager(): WindowManager {
  resetSingleton(WindowManager);
  return WindowManager.getInstance();
}

/**
 * Create a mock WindowManager-like object for TabManager tests.
 * This avoids needing the real WindowManager and its Chrome API dependencies.
 */
export function createMockWindowManager(trackers: TabTracker[], initialTabIds: number[] = []) {
  const initialSet = new Set(initialTabIds);
  return {
    getWindowTracker(windowId: number): TabTracker | null {
      return trackers.find((t) => t.wid === windowId) ?? null;
    },
    isInitialTab(tabId: number): boolean {
      return initialSet.has(tabId);
    },
    findTab(tabId: number): TabInfo {
      for (const tracker of trackers) {
        const index = tracker.tabarr.findIndex((entry) => entry.tabId === tabId);
        if (index !== -1) {
          return { tabarr: tracker.tabarr, tabloc: index };
        }
      }
      return { tabarr: null, tabloc: -1 };
    },
    getAllTrackers(): TabTracker[] {
      return trackers;
    },
    reconcileWithBrowserState: vi.fn(() => Promise.resolve()),
  };
}

/**
 * Create a TabTracker with tabs having specific order values.
 */
export function createTracker(
  windowId: number,
  tabs: Array<{ id: number; order: number }>,
  moveok: boolean = true,
): TabTracker {
  return {
    wid: windowId,
    moveok,
    tabarr: tabs.map((t) => ({ tabId: t.id, order: t.order })),
  };
}

/**
 * Get MRU-sorted tab IDs from a tracker (most recent first).
 */
export function getMRUSortedTabIds(tracker: TabTracker): number[] {
  return [...tracker.tabarr].sort((a, b) => b.order - a.order).map((e) => e.tabId);
}

/**
 * Sleep for ms milliseconds (useful for testing debounce/timing).
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
