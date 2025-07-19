// Tab Manager for FLST Chrome extension

import { logger } from "../utils/logger.js";
import { storageManager } from "./storage-manager.js";
import { settingsManager } from "./settings-manager.js";
import { SkipActivationReason } from "../types.js";
import type {
  TabTracker,
  TabInfo,
  SafeTabMoveCallback,
  TabMRUEntry,
  SkipActivationInfo,
} from "../types.js";

export class TabManager {
  private static instance: TabManager;
  private skipNextActivation: SkipActivationInfo | null = null;

  private constructor() {}

  public static getInstance(): TabManager {
    if (!TabManager.instance) {
      TabManager.instance = new TabManager();
    }
    return TabManager.instance;
  }

  /**
   * Add tab to MRU array with proper timestamp ordering
   */
  private addTabToMRU(
    tabarr: TabMRUEntry[],
    tabId: number,
    position: "first" | "last" = "last"
  ): void {
    const order = Date.now();
    const entry: TabMRUEntry = { tabId, order };

    if (position === "first") {
      tabarr.unshift(entry);
    } else {
      tabarr.push(entry);
    }
  }

  /**
   * Remove tab from MRU array
   */
  private removeTabFromMRU(tabarr: TabMRUEntry[], tabId: number): number {
    const index = tabarr.findIndex((entry) => entry.tabId === tabId);
    if (index !== -1) {
      tabarr.splice(index, 1);
    }
    return index;
  }

  /**
   * Update tab timestamp in MRU array (when tab is activated)
   */
  private updateTabTimestamp(tabarr: TabMRUEntry[], tabId: number): void {
    const entry = tabarr.find((entry) => entry.tabId === tabId);
    if (entry) {
      entry.order = Date.now();
      logger.debug(`Updated timestamp for tab ${tabId} to ${entry.order}`);
    }
  }

  /**
   * Get most recently used tab ID (highest timestamp)
   */
  private getMostRecentTabId(tabarr: TabMRUEntry[]): number | null {
    if (tabarr.length === 0) return null;

    // Sort by timestamp to get the most recent (highest timestamp)
    const sorted = [...tabarr].sort((a, b) => b.order - a.order);
    return sorted[0].tabId;
  }

  /**
   * Find tab in MRU array and return info
   */
  private findTabInMRU(
    tabarr: TabMRUEntry[],
    tabId: number
  ): { entry: TabMRUEntry; index: number } | null {
    const index = tabarr.findIndex((entry) => entry.tabId === tabId);
    if (index === -1) return null;
    return { entry: tabarr[index], index };
  }

  /**
   * Safe tab move with retry logic for handling drag operations
   */
  public safeTabMove(
    tabId: number,
    moveProperties: any,
    callback?: SafeTabMoveCallback,
    retryCount: number = 0
  ): void {
    const maxRetries = 3;
    const retryDelay = 200;

    chrome.tabs.move(tabId, moveProperties, (result: any) => {
      if (chrome.runtime.lastError) {
        const errorMsg = chrome.runtime.lastError.message;

        if (errorMsg?.includes("user may be dragging") && retryCount < maxRetries) {
          logger.debug(
            `Tab move failed (user dragging), retrying in ${retryDelay}ms (attempt ${
              retryCount + 1
            }/${maxRetries})`
          );
          setTimeout(() => {
            this.safeTabMove(tabId, moveProperties, callback, retryCount + 1);
          }, retryDelay);
          return;
        }

        logger.error(`Tab move failed: ${errorMsg}`);
        if (callback) callback(null, errorMsg);
      } else {
        if (callback) callback(result, null);
      }
    });
  }

  /**
   * Focus a tab and prevent reordering with retry logic
   */
  public setFocus(tabId: number, reason: SkipActivationReason): void {
    this.skipNextActivation = { reason };
    this.safeTabUpdate(tabId, { active: true });
  }

  /**
   * Safe tab update with retry logic for handling drag operations
   */
  private safeTabUpdate(tabId: number, updateProperties: any, retryCount: number = 0): void {
    const maxRetries = 3;
    const retryDelay = 200;

    chrome.tabs.update(tabId, updateProperties, (result: any) => {
      if (chrome.runtime.lastError) {
        const errorMsg = chrome.runtime.lastError.message;

        if (errorMsg?.includes("user may be dragging") && retryCount < maxRetries) {
          logger.debug(
            `Tab update failed (user dragging), retrying in ${retryDelay}ms (attempt ${
              retryCount + 1
            }/${maxRetries})`
          );
          setTimeout(() => {
            this.safeTabUpdate(tabId, updateProperties, retryCount + 1);
          }, retryDelay);
          return;
        }

        // If it's still a dragging error after all retries, just log as debug instead of error
        if (errorMsg?.includes("user may be dragging")) {
          logger.debug(
            `Tab update abandoned after ${maxRetries} retries - user still dragging tab ${tabId}`
          );
        } else {
          // Log other errors normally
          logger.error(`Tab update failed: ${errorMsg}`);
        }
      } else {
        logger.debug(`Tab ${tabId} updated successfully`);
      }
    });
  }

  /**
   * Handle new tab creation
   */
  public async handleNewTab(tabObj: any, windowManager: any): Promise<void> {
    const logPrefix = "NewTab: ";

    if (!tabObj.windowId) {
      logger.debug(`${logPrefix}Tab has no windowId`);
      return;
    }

    let tracker = windowManager.getWindowTracker(tabObj.windowId);
    if (!tracker) {
      logger.debug(
        `${logPrefix}Window ${tabObj.windowId} not found in tracking - triggering reconciliation`
      );

      // Trigger reconciliation to fix missing window/tab tracking
      try {
        await windowManager.reconcileWithBrowserState();
        // Try to get the tracker again after reconciliation
        tracker = windowManager.getWindowTracker(tabObj.windowId);
      } catch (error) {
        logger.error(`${logPrefix}Reconciliation failed`, error);
      }

      if (!tracker) {
        logger.warn(`${logPrefix}Window ${tabObj.windowId} still not found after reconciliation`);
        return;
      }
    }

    const settings = settingsManager.getSettings();
    logger.debug(
      `${logPrefix}windowId ${tabObj.windowId}, id ${tabObj.id}, reloc: ${settings.reloc}, ntsel: ${settings.ntsel}`
    );

    // Handle tab relocation
    if (settings.reloc && tracker.moveok && tabObj.id) {
      await this.relocateTabToFarRight(tabObj, logPrefix);
    }

    // Handle new tab selection and tracking based on ntsel option
    if (tabObj.id) {
      // Check if tab is already in MRU (in case reconciliation added it)
      const existingIndex = tracker.tabarr.findIndex((entry) => entry.tabId === tabObj.id);
      if (existingIndex === -1) {
        if (settings.ntsel) {
          // Select new tab and add to end of array (most recently used)
          this.setFocus(tabObj.id, SkipActivationReason.NEW_TAB);
          this.addTabToMRU(tracker.tabarr, tabObj.id, "last");
          logger.debug(`${logPrefix}[select new tab]`);
        } else {
          // Chrome standard behavior - don't select, add to beginning
          this.addTabToMRU(tracker.tabarr, tabObj.id, "first");
          logger.debug(`${logPrefix}[chrome standard - don't select]`);
        }
      } else {
        logger.debug(`${logPrefix}Tab already exists in MRU at index ${existingIndex}`);
      }
      await storageManager.saveTrackingState(windowManager.getAllTrackers());
    }

    logger.debug(`${logPrefix}Tab processed successfully`);
  }

  /**
   * Relocate tab to far right
   */
  private async relocateTabToFarRight(tabObj: any, logPrefix: string): Promise<void> {
    return new Promise((resolve) => {
      chrome.tabs.get(tabObj.id, (tab: any) => {
        if (chrome.runtime.lastError) {
          logger.debug(`${logPrefix}Tab ${tabObj.id} no longer exists`);
          resolve();
          return;
        }

        chrome.tabs.query({ windowId: tabObj.windowId }, (tabs: any[]) => {
          if (chrome.runtime.lastError) {
            logger.error(`${logPrefix}Query error: ${chrome.runtime.lastError.message}`);
            resolve();
            return;
          }

          const tabIndex = tabs.findIndex((t) => t.id === tabObj.id);
          if (tabIndex !== -1 && tabIndex !== tabs.length - 1) {
            this.safeTabMove(tabObj.id, { index: -1 }, (result, error) => {
              if (error) {
                logger.error(`${logPrefix}Move failed after retries: ${error}`);
              } else {
                logger.debug(
                  `${logPrefix}Tab ${tabObj.id} moved to far right (was at index ${tabIndex})`
                );
              }
              resolve();
            });
          } else {
            logger.debug(`${logPrefix}Tab ${tabObj.id} already at far right`);
            resolve();
          }
        });
      });
    });
  }

  /**
   * Handle tab closing
   */
  public async handleTabClose(tabId: number, windowManager: any): Promise<void> {
    logger.debug(`TabManager: handleTabClose called for tabId ${tabId}`);

    const info = windowManager.findTab(tabId);
    if (!info.tabarr) {
      logger.debug(`CloseTab: tabid ${tabId} not found`);
      return;
    }

    const settings = settingsManager.getSettings();
    const tabarr = info.tabarr;
    const tabloc = info.tabloc;

    logger.debug(`CloseTab: tabid ${tabId}, flip option: ${settings.flip}`);
    logger.debug(`CloseTab: (before) [${tabarr.map((e) => e.tabId)}]`);

    // Handle tab selection BEFORE removing from MRU if flip is enabled
    if (tabarr.length > 1 && settings.flip) {
      // Get the most recent tab BEFORE removing the current tab
      const nextTabId = this.getMostRecentTabExcluding(tabarr, tabId);
      if (nextTabId) {
        logger.debug(`CloseTab: Tab flipping ON - will select most recent tab: ${nextTabId}`);

        // Store the expected next tab to handle Chrome's automatic selection
        this.skipNextActivation = {
          reason: SkipActivationReason.CLOSE_TAB,
          expectedTabId: nextTabId,
        };

        // Immediately select the correct tab
        this.setFocus(nextTabId, SkipActivationReason.CLOSE_TAB);
      }
    } else {
      logger.debug(
        `CloseTab: Tab flipping OFF or no tabs remaining - letting Chrome handle selection`
      );
    }

    // Remove the tab from MRU
    tabarr.splice(tabloc, 1);
    logger.debug(`CloseTab: (after) [${tabarr.map((e) => e.tabId)}]`);

    await storageManager.saveTrackingState(windowManager.getAllTrackers());
  }

  /**
   * Get most recently used tab ID excluding a specific tab
   */
  private getMostRecentTabExcluding(tabarr: TabMRUEntry[], excludeTabId: number): number | null {
    if (tabarr.length === 0) return null;

    // Filter out the excluded tab and sort by timestamp to get the most recent
    const filtered = tabarr.filter((entry) => entry.tabId !== excludeTabId);
    if (filtered.length === 0) return null;

    const sorted = [...filtered].sort((a, b) => b.order - a.order);
    return sorted[0].tabId;
  }
  /**
   * Handle tab activation (selection)
   */
  public async handleTabActivation(info: any, windowManager: any): Promise<void> {
    if (this.skipNextActivation) {
      const skipInfo = this.skipNextActivation;
      logger.debug(`Shuffle: skip => ${skipInfo.reason}`);

      // Check if this is the expected tab from a close operation
      if (skipInfo.reason === SkipActivationReason.CLOSE_TAB && skipInfo.expectedTabId) {
        if (skipInfo.expectedTabId === info.tabId) {
          logger.debug(
            `Shuffle: Expected tab ${skipInfo.expectedTabId} activated after close - allowing`
          );
          this.skipNextActivation = null;
          // Don't return - let it update the timestamp normally
        } else {
          logger.debug(
            `Shuffle: Unexpected tab ${info.tabId} activated, expected ${skipInfo.expectedTabId} - correcting`
          );
          this.skipNextActivation = null;
          // Try to select the correct tab again
          this.setFocus(skipInfo.expectedTabId, SkipActivationReason.CLOSE_TAB_CORRECTION);
          return;
        }
      } else {
        this.skipNextActivation = null;
        return;
      }
    }

    let tracker = windowManager.getWindowTracker(info.windowId);
    if (!tracker) {
      logger.debug(`Shuffle: window ${info.windowId} not found - triggering reconciliation`);

      // Trigger reconciliation to fix missing window/tab tracking
      try {
        await windowManager.reconcileWithBrowserState();
        // Try to get the tracker again after reconciliation
        tracker = windowManager.getWindowTracker(info.windowId);
      } catch (error) {
        logger.error(`Shuffle: Reconciliation failed`, error);
      }

      if (!tracker) {
        logger.warn(`Shuffle: window ${info.windowId} still not found after reconciliation`);
        return;
      }
    }

    const tabarr = tracker.tabarr;
    let tabInfo = this.findTabInMRU(tabarr, info.tabId);

    if (!tabInfo) {
      logger.debug(`Shuffle: tabId ${info.tabId} not found in MRU - triggering reconciliation`);

      // Trigger reconciliation to fix missing tab tracking
      try {
        await windowManager.reconcileWithBrowserState();
        // Try to find the tab again after reconciliation
        tabInfo = this.findTabInMRU(tabarr, info.tabId);
      } catch (error) {
        logger.error(`Shuffle: Reconciliation failed`, error);
      }

      if (!tabInfo) {
        logger.warn(
          `Shuffle: tabId ${info.tabId} still not found after reconciliation, tabarr: [${tabarr.map(
            (e) => e.tabId
          )}]`
        );
        return;
      }
    }

    // Check if it's already the most recent (highest timestamp)
    const mostRecentTabId = this.getMostRecentTabId(tabarr);
    if (mostRecentTabId === info.tabId) {
      logger.debug(`Shuffle: tabId ${info.tabId} already most recent`);
      return;
    }

    logger.debug(`Shuffle: (before) [${tabarr.map((e) => e.tabId)}]`);
    this.updateTabTimestamp(tabarr, info.tabId);
    logger.debug(`Shuffle: (after) [${tabarr.map((e) => e.tabId)}]`);

    await storageManager.saveTrackingState(windowManager.getAllTrackers());
  }

  /**
   * Handle tab replacement
   */
  public handleTabReplacement(newId: number, oldId: number, windowManager: any): void {
    const info = windowManager.findTab(oldId);
    if (info.tabarr && info.tabloc !== -1) {
      info.tabarr[info.tabloc].tabId = newId;
      logger.debug(`TabReplaced: ${oldId} -> ${newId}`);
    }
  }

  /**
   * Handle tab attachment to window
   */
  public handleTabAttach(tabId: number, attachInfo: any, windowManager: any): void {
    const tracker = windowManager.getWindowTracker(attachInfo.newWindowId);
    if (tracker) {
      this.addTabToMRU(tracker.tabarr, tabId, "last");
      this.skipNextActivation = { reason: SkipActivationReason.ATTACH };
      logger.debug(`TabAttached: ${tabId} to window ${attachInfo.newWindowId}`);
    }
  }

  /**
   * Handle tab detachment from window
   */
  public handleTabDetach(tabId: number, detachInfo: any, windowManager: any): void {
    const tracker = windowManager.getWindowTracker(detachInfo.oldWindowId);
    if (!tracker) return;

    this.removeTabFromMRU(tracker.tabarr, tabId);

    logger.debug(`Tracker: ${tracker.tabarr.length}`);
    if (tracker.tabarr.length > 0) {
      const lastTabId = this.getMostRecentTabId(tracker.tabarr);
      logger.debug(
        `TabDetached: ${tabId} from window ${detachInfo.oldWindowId}, last tab: ${lastTabId}`
      );
      if (lastTabId) {
        this.setFocus(lastTabId, SkipActivationReason.DETACH);
      }
    }

    logger.debug(`TabDetached: ${tabId} from window ${detachInfo.oldWindowId}`);
  }

  /**
   * Handle tab flipping (when extension icon is clicked)
   */
  public async handleTabFlip(tab: any, windowManager: any): Promise<void> {
    const settings = settingsManager.getSettings();
    if (!settings.flip || !tab.windowId) return;

    let tracker = windowManager.getWindowTracker(tab.windowId);
    if (!tracker) {
      logger.debug(`TabFlip: window ${tab.windowId} not found - triggering reconciliation`);

      // Trigger reconciliation to fix missing window/tab tracking
      try {
        await windowManager.reconcileWithBrowserState();
        // Try to get the tracker again after reconciliation
        tracker = windowManager.getWindowTracker(tab.windowId);
      } catch (error) {
        logger.error(`TabFlip: Reconciliation failed`, error);
      }

      if (!tracker) {
        logger.warn(`TabFlip: window ${tab.windowId} still not found after reconciliation`);
        return;
      }
    }

    if (tracker.tabarr.length < 2) {
      logger.debug(`TabFlip: Not enough tabs in window ${tab.windowId}`);
      return;
    }

    // Get the second most recent tab (previous in MRU order)
    const sorted = [...tracker.tabarr].sort((a, b) => b.order - a.order);
    if (sorted.length >= 2) {
      const previousTabId = sorted[1].tabId;
      this.updateTabTimestamp(tracker.tabarr, previousTabId);
      this.setFocus(previousTabId, SkipActivationReason.TAB_FLIP);
      logger.debug(`TabFlip: Switched to previous tab ${previousTabId}`);
    }
  }
}

// Export singleton instance
export const tabManager = TabManager.getInstance();
