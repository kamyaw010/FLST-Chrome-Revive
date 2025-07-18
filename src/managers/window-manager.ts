// Window Manager for FLST Chrome extension

import { logger } from "../utils/logger.js";
import { storageManager } from "./storage-manager.js";
import type { TabTracker, TabInfo, TabMRUEntry } from "../types.js";

export class WindowManager {
  private static instance: WindowManager;
  private trackers: TabTracker[] = [];

  private constructor() {}

  public static getInstance(): WindowManager {
    if (!WindowManager.instance) {
      WindowManager.instance = new WindowManager();
    }
    return WindowManager.instance;
  }

  /**
   * Create a TabMRUEntry with current timestamp
   */
  private createTabEntry(tabId: number): TabMRUEntry {
    return { tabId, order: Date.now() };
  }

  /**
   * Initialize window tracking from current browser state
   */
  public async initializeTracking(): Promise<void> {
    logger.debug("Initializing window tracking...");

    // Try to restore from storage first
    const restoredState = await this.restoreTrackingState();

    return new Promise((resolve, reject) => {
      chrome.windows.getAll({ populate: true }, async (windows: any[]) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
          return;
        }

        try {
          if (restoredState && this.validateRestoredState(windows, restoredState)) {
            logger.debug("Successfully restored tracking state from storage");
            this.trackers = restoredState;
          } else {
            logger.debug("Building fresh tracking state from current browser state");
            this.setTracking(windows);
          }

          // Always save current state after initialization
          await storageManager.saveTrackingState(this.trackers);

          logger.debug(`Window tracking initialized: ${this.trackers.length} windows`);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  /**
   * Restore tracking state from storage
   */
  private async restoreTrackingState(): Promise<TabTracker[] | null> {
    try {
      const restored = await storageManager.loadTrackingState();
      return restored.length > 0 ? restored : null;
    } catch (error) {
      logger.error("Failed to restore tracking state", error);
      return null;
    }
  }

  /**
   * Validate that restored state matches current browser state
   */
  private validateRestoredState(currentWindows: any[], restoredState: TabTracker[]): boolean {
    // Check if the number of windows matches
    if (currentWindows.length !== restoredState.length) {
      logger.debug("Window count mismatch, rebuilding state");
      return false;
    }

    // Check if each window still exists and has matching tabs
    for (const tracker of restoredState) {
      const currentWindow = currentWindows.find((w) => w.id === tracker.wid);
      if (!currentWindow) {
        logger.debug(`Window ${tracker.wid} no longer exists`);
        return false;
      }

      // Check if tabs still exist
      const currentTabIds = currentWindow.tabs.map((t: any) => t.id).sort();
      const trackedTabIds = tracker.tabarr.slice().sort();

      if (currentTabIds.length !== trackedTabIds.length) {
        logger.debug(`Tab count mismatch for window ${tracker.wid}`);
        return false;
      }

      // Check if all tabs still exist
      for (const tabId of trackedTabIds) {
        if (!currentTabIds.includes(tabId)) {
          logger.debug(`Tab ${tabId} no longer exists in window ${tracker.wid}`);
          return false;
        }
      }
    }

    return true;
  }
  /**
   * Set up tracking for multiple windows
   */
  private setTracking(windows: any[]): void {
    if (!Array.isArray(windows)) return;

    this.trackers = [];
    for (const window of windows) {
      if (window) {
        this.addWindow(window);
      }
    }
  }

  /**
   * Add a window to tracking
   */
  public async addWindow(windowObj: any): Promise<void> {
    if (!windowObj || !windowObj.id) {
      logger.debug(`AddWindow: Invalid window object`);
      return;
    }

    const tracker: TabTracker = {
      tabarr: [],
      wid: windowObj.id,
      moveok: windowObj.type === "normal",
    };

    if (!windowObj.tabs || !Array.isArray(windowObj.tabs)) {
      logger.debug(`AddWindow: Window ${windowObj.id} has no tabs or tabs is not an array`);
      this.trackers.push(tracker);
      await storageManager.saveTrackingState(this.trackers);
      return;
    }

    let selectedId = -1;
    for (const tab of windowObj.tabs) {
      if (!tab || !tab.id) continue;

      if (!tab.active) {
        tracker.tabarr.push(this.createTabEntry(tab.id));
      } else {
        selectedId = tab.id;
      }
    }

    if (selectedId !== -1) {
      tracker.tabarr.push(this.createTabEntry(selectedId));
    }

    this.trackers.push(tracker);
    logger.debug(
      `AddWindow: Window ${windowObj.id}, selected tab ${selectedId}, tabs: [${tracker.tabarr.map(
        (e) => e.tabId
      )}]`
    );

    // Save state after adding window
    await storageManager.saveTrackingState(this.trackers);
  }

  /**
   * Remove a window from tracking
   */
  public async removeWindow(windowId: number): Promise<void> {
    const index = this.trackers.findIndex((tracker) => tracker.wid === windowId);
    if (index !== -1) {
      this.trackers.splice(index, 1);
      logger.debug(`RemoveWindow: Window ${windowId} removed`);
      await storageManager.saveTrackingState(this.trackers);
    }
  }

  /**
   * Get tracker for a specific window
   */
  public getWindowTracker(windowId: number): TabTracker | null {
    const tracker = this.trackers.find((t) => t.wid === windowId);

    if (!tracker) {
      logger.debug(`Window ${windowId} not found in tracking - attempting to reinitialize`);
      this.reinitializeWindow(windowId);
      return null;
    }

    return tracker;
  }

  /**
   * Reinitialize a specific window
   */
  private reinitializeWindow(windowId: number): void {
    chrome.windows.get(windowId, { populate: true }, (window: any) => {
      if (!chrome.runtime.lastError && window) {
        this.addWindow(window);
      }
    });
  }

  /**
   * Find a tab across all windows
   */
  public findTab(tabId: number): TabInfo {
    for (const tracker of this.trackers) {
      const index = tracker.tabarr.findIndex((entry) => entry.tabId === tabId);
      if (index !== -1) {
        return { tabarr: tracker.tabarr, tabloc: index };
      }
    }
    return { tabarr: null, tabloc: -1 };
  }

  /**
   * Get all trackers
   */
  public getAllTrackers(): TabTracker[] {
    return this.trackers;
  }

  /**
   * Get tracking statistics
   */
  public getTrackingStats(): { windowCount: number; totalTabs: number } {
    const windowCount = this.trackers.length;
    const totalTabs = this.trackers.reduce((sum, tracker) => sum + tracker.tabarr.length, 0);
    return { windowCount, totalTabs };
  }

  /**
   * Clear all tracking data
   */
  public async clearTracking(): Promise<void> {
    this.trackers = [];
    await storageManager.clearTrackingState();
  }

  /**
   * Validate tracking consistency
   */
  public validateTracking(): boolean {
    for (const tracker of this.trackers) {
      if (!tracker.tabarr || !Array.isArray(tracker.tabarr)) {
        logger.warn(`Invalid tracker for window ${tracker.wid}: tabarr is not an array`);
        return false;
      }

      // Check for duplicate tabs
      const tabIds = tracker.tabarr.map((entry) => entry.tabId);
      const uniqueTabs = new Set(tabIds);
      if (uniqueTabs.size !== tabIds.length) {
        logger.warn(`Duplicate tabs found in window ${tracker.wid}`);
        return false;
      }

      // Check for invalid entries
      for (const entry of tracker.tabarr) {
        if (!entry.tabId || !entry.order) {
          logger.warn(`Invalid MRU entry in window ${tracker.wid}: ${JSON.stringify(entry)}`);
          return false;
        }
      }
    }
    return true;
  }

  /**
   * Reconcile MRU arrays with actual browser tabs
   * This is crucial after service worker reactivation
   */
  public async reconcileWithBrowserState(): Promise<void> {
    logger.debug("Starting MRU reconciliation with browser state...");

    return new Promise((resolve) => {
      chrome.windows.getAll({ populate: true }, async (windows: any[]) => {
        if (chrome.runtime.lastError) {
          logger.error("Failed to get windows for reconciliation", chrome.runtime.lastError);
          resolve();
          return;
        }

        let reconciliationChanges = 0;

        for (const window of windows) {
          if (!window || !window.id || !window.tabs) continue;

          // Find or create tracker for this window
          let tracker = this.trackers.find((t) => t.wid === window.id);
          if (!tracker) {
            logger.debug(`Creating new tracker for window ${window.id} during reconciliation`);
            await this.addWindow(window);
            reconciliationChanges++;
            continue;
          }

          // Get current tab IDs in the window
          const currentTabIds = window.tabs
            .map((tab: any) => tab.id)
            .filter((id: number) => id != null);
          const trackedTabIds = tracker.tabarr.map((entry) => entry.tabId);

          // Find tabs that exist in browser but not in MRU
          const missingTabs = currentTabIds.filter(
            (tabId: number) => !trackedTabIds.includes(tabId)
          );

          if (missingTabs.length > 0) {
            logger.debug(
              `Found ${missingTabs.length} missing tabs in window ${window.id}: [${missingTabs.join(
                ", "
              )}]`
            );

            // Add missing tabs to MRU with current timestamp
            for (const tabId of missingTabs) {
              const tab = window.tabs.find((t: any) => t.id === tabId);
              if (tab) {
                const entry = this.createTabEntry(tabId);

                // If this is the active tab, put it at the end (most recent)
                if (tab.active) {
                  tracker.tabarr.push(entry);
                  logger.debug(`Added active tab ${tabId} to end of MRU for window ${window.id}`);
                } else {
                  // Insert non-active tabs at the beginning (less recent)
                  tracker.tabarr.unshift(entry);
                  logger.debug(
                    `Added inactive tab ${tabId} to beginning of MRU for window ${window.id}`
                  );
                }
                reconciliationChanges++;
              }
            }
          }

          // Remove tabs that are in MRU but don't exist in browser
          const orphanedTabs = trackedTabIds.filter(
            (tabId: number) => !currentTabIds.includes(tabId)
          );

          if (orphanedTabs.length > 0) {
            logger.debug(
              `Found ${orphanedTabs.length} orphaned tabs in window ${
                window.id
              }: [${orphanedTabs.join(", ")}]`
            );

            for (const tabId of orphanedTabs) {
              const index = tracker.tabarr.findIndex((entry) => entry.tabId === tabId);
              if (index !== -1) {
                tracker.tabarr.splice(index, 1);
                logger.debug(`Removed orphaned tab ${tabId} from MRU for window ${window.id}`);
                reconciliationChanges++;
              }
            }
          }
        }

        // Remove trackers for windows that no longer exist
        const currentWindowIds = windows.map((w) => w.id);
        const orphanedTrackers = this.trackers.filter(
          (tracker) => !currentWindowIds.includes(tracker.wid)
        );

        if (orphanedTrackers.length > 0) {
          logger.debug(`Found ${orphanedTrackers.length} orphaned window trackers`);
          this.trackers = this.trackers.filter((tracker) => currentWindowIds.includes(tracker.wid));
          reconciliationChanges += orphanedTrackers.length;
        }

        if (reconciliationChanges > 0) {
          logger.debug(`Reconciliation completed with ${reconciliationChanges} changes`);
          await storageManager.saveTrackingState(this.trackers);
        } else {
          logger.debug("Reconciliation completed - no changes needed");
        }

        resolve();
      });
    });
  }
}

// Export singleton instance
export const windowManager = WindowManager.getInstance();
