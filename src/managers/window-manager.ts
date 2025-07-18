// Window Manager for FLST Chrome extension

import { logger } from "../utils/logger.js";
import { storageManager } from "./storage-manager.js";
import type { TabTracker, TabInfo } from "../types.js";

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
        tracker.tabarr.push(tab.id);
      } else {
        selectedId = tab.id;
      }
    }

    if (selectedId !== -1) {
      tracker.tabarr.push(selectedId);
    }

    this.trackers.push(tracker);
    logger.debug(
      `AddWindow: Window ${windowObj.id}, selected tab ${selectedId}, tabs: [${tracker.tabarr}]`
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
      const index = tracker.tabarr.indexOf(tabId);
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
      const uniqueTabs = new Set(tracker.tabarr);
      if (uniqueTabs.size !== tracker.tabarr.length) {
        logger.warn(`Duplicate tabs found in window ${tracker.wid}`);
        return false;
      }
    }
    return true;
  }
}

// Export singleton instance
export const windowManager = WindowManager.getInstance();
