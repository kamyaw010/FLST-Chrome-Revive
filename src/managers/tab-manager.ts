// Tab Manager for FLST Chrome extension

import { logger } from "../utils/logger.js";
import { storageManager } from "./storage-manager.js";
import { settingsManager } from "./settings-manager.js";
import type { TabTracker, TabInfo, SafeTabMoveCallback } from "../types.js";

export class TabManager {
  private static instance: TabManager;
  private skipNextActivation: string | null = null;

  private constructor() {}

  public static getInstance(): TabManager {
    if (!TabManager.instance) {
      TabManager.instance = new TabManager();
    }
    return TabManager.instance;
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
   * Focus a tab and prevent reordering
   */
  public setFocus(tabId: number, reason: string): void {
    this.skipNextActivation = reason;
    chrome.tabs.update(tabId, { active: true });
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

    const tracker = windowManager.getWindowTracker(tabObj.windowId);
    if (!tracker) {
      logger.debug(`${logPrefix}Window ${tabObj.windowId} not found in tracking`);
      return;
    }

    const settings = settingsManager.getSettings();
    logger.debug(
      `${logPrefix}windowId ${tabObj.windowId}, id ${tabObj.id}, reloc: ${settings.reloc}`
    );

    // Handle tab relocation
    if (settings.reloc && tracker.moveok && tabObj.id) {
      await this.relocateTabToFarRight(tabObj, logPrefix);
    }

    // Add tab to tracking
    if (tabObj.id) {
      tracker.tabarr.push(tabObj.id);
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
    const info = windowManager.findTab(tabId);
    if (!info.tabarr) {
      logger.debug(`CloseTab: tabid ${tabId} not found`);
      return;
    }

    const settings = settingsManager.getSettings();
    const tabarr = info.tabarr;
    const tabloc = info.tabloc;
    const tabcount = tabarr.length;

    logger.debug(`CloseTab: tabid ${tabId}, flip option: ${settings.flip}`);
    logger.debug(`CloseTab: (before) [${tabarr}]`);

    tabarr.splice(tabloc, 1);
    logger.debug(`CloseTab: (after) [${tabarr}]`);

    await storageManager.saveTrackingState(windowManager.getAllTrackers());

    // Handle tab selection after close
    if (tabcount - 1 > 1 && tabloc === tabcount - 1) {
      if (settings.flip) {
        const nextTabId = tabarr[tabarr.length - 1];
        logger.debug(`CloseTab: Tab flipping ON - selecting last tab: ${nextTabId}`);
        this.setFocus(nextTabId, "CloseTab");
      } else {
        logger.debug(`CloseTab: Tab flipping OFF - letting Chrome handle selection`);
      }
    }
  }

  /**
   * Handle tab activation (selection)
   */
  public async handleTabActivation(info: any, windowManager: any): Promise<void> {
    if (this.skipNextActivation) {
      logger.debug(`Shuffle: skip => ${this.skipNextActivation}`);
      this.skipNextActivation = null;
      return;
    }

    const tracker = windowManager.getWindowTracker(info.windowId);
    if (!tracker) {
      logger.debug(`Shuffle: window ${info.windowId} not found`);
      return;
    }

    const tabarr = tracker.tabarr;
    const tabIndex = tabarr.indexOf(info.tabId);

    if (tabIndex === -1) {
      logger.debug(`Shuffle: tabId not found, tabarr: [${tabarr}]`);
      return;
    }

    if (tabIndex === tabarr.length - 1) {
      logger.debug(`Shuffle: tabId ${info.tabId} already last`);
      return;
    }

    logger.debug(`Shuffle: (before) [${tabarr}]`);
    tabarr.splice(tabIndex, 1);
    tabarr.push(info.tabId);
    logger.debug(`Shuffle: (after) [${tabarr}]`);

    await storageManager.saveTrackingState(windowManager.getAllTrackers());
  }

  /**
   * Handle tab replacement
   */
  public handleTabReplacement(newId: number, oldId: number, windowManager: any): void {
    const info = windowManager.findTab(oldId);
    if (info.tabarr) {
      info.tabarr[info.tabloc] = newId;
      logger.debug(`TabReplaced: ${oldId} -> ${newId}`);
    }
  }

  /**
   * Handle tab attachment to window
   */
  public handleTabAttach(tabId: number, attachInfo: any, windowManager: any): void {
    const tracker = windowManager.getWindowTracker(attachInfo.newWindowId);
    if (tracker) {
      tracker.tabarr.push(tabId);
      this.skipNextActivation = "Attach";
      logger.debug(`TabAttached: ${tabId} to window ${attachInfo.newWindowId}`);
    }
  }

  /**
   * Handle tab detachment from window
   */
  public handleTabDetach(tabId: number, detachInfo: any, windowManager: any): void {
    const tracker = windowManager.getWindowTracker(detachInfo.oldWindowId);
    if (!tracker) return;

    const tabIndex = tracker.tabarr.indexOf(tabId);
    if (tabIndex !== -1) {
      tracker.tabarr.splice(tabIndex, 1);
    }

    if (tracker.tabarr.length > 1) {
      const lastTabId = tracker.tabarr[tracker.tabarr.length - 1];
      if (lastTabId) {
        this.setFocus(lastTabId, "Detach");
      }
    }

    logger.debug(`TabDetached: ${tabId} from window ${detachInfo.oldWindowId}`);
  }

  /**
   * Handle tab flipping (when extension icon is clicked)
   */
  public handleTabFlip(tab: any, windowManager: any): void {
    const settings = settingsManager.getSettings();
    if (!settings.flip || !tab.windowId) return;

    const tracker = windowManager.getWindowTracker(tab.windowId);
    if (!tracker || tracker.tabarr.length < 2) return;

    // Switch to second-to-last tab (previous)
    const tabIndex = tracker.tabarr.length - 2;
    const tabId = tracker.tabarr[tabIndex];
    if (tabId) {
      tracker.tabarr.splice(tabIndex, 1);
      tracker.tabarr.push(tabId);
      this.setFocus(tabId, "TabFlip");
      logger.debug(`TabFlip: Switched to previous tab ${tabId}`);
    }
  }
}

// Export singleton instance
export const tabManager = TabManager.getInstance();
