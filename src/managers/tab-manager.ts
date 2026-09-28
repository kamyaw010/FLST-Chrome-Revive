// Tab Manager for FLST Chrome extension

import { logger } from "../utils/logger.js";
import { handleNewTabEvent } from "./tab-operations/new-tab-handler.js";
import { handleTabCloseEvent } from "./tab-operations/close-tab-handler.js";
import { handleTabActivationEvent } from "./tab-operations/activation-handler.js";
import { settingsManager } from "./settings-manager.js";
import {
  handleTabAttachEvent,
  handleTabDetachEvent,
  handleTabFlipEvent,
  handleTabReplacementEvent,
} from "./tab-operations/secondary-handlers.js";
import { SkipActivationReason } from "../types.js";
import type { SafeTabMoveCallback, SkipActivationInfo } from "../types.js";
import type { CloseOperationInfo, TabManagerRuntime } from "./tab-operations/runtime.js";

export class TabManager {
  private static instance: TabManager;
  private skipNextActivation: SkipActivationInfo | null = null;
  private operationQueue: Map<number, Promise<void>> = new Map();
  private lastCloseInfo: CloseOperationInfo | null = null;
  private lastKnownActiveTabIds: Map<number, number> = new Map();
  private recentSelectedNewTabs: Map<number, { tabId: number; timestamp: number }> = new Map();
  private managedNewTabs: Map<
    number,
    { suppressRelocation: boolean; suppressActivation: boolean }
  > = new Map();

  private constructor() {}

  public static getInstance(): TabManager {
    if (!TabManager.instance) {
      TabManager.instance = new TabManager();
    }
    return TabManager.instance;
  }

  /**
   * Queue operations per window to prevent race conditions
   */
  private async queueOperation(windowId: number, operation: () => Promise<void>): Promise<void> {
    // Wait for any existing operation on this window
    const existingOperation = this.operationQueue.get(windowId);
    if (existingOperation) {
      await existingOperation.catch(() => {}); // Ignore errors from previous operations
    }

    // Create and store the new operation
    const newOperation = operation().finally(() => {
      // Clean up the operation from the queue when done
      if (this.operationQueue.get(windowId) === newOperation) {
        this.operationQueue.delete(windowId);
      }
    });

    this.operationQueue.set(windowId, newOperation);
    return newOperation;
  }

  private createRuntime(): TabManagerRuntime {
    const self = this;

    return {
      get skipNextActivation() {
        return self.skipNextActivation;
      },
      set skipNextActivation(value) {
        self.skipNextActivation = value;
      },
      get lastCloseInfo() {
        return self.lastCloseInfo;
      },
      set lastCloseInfo(value) {
        self.lastCloseInfo = value;
      },
      lastKnownActiveTabIds: self.lastKnownActiveTabIds,
      recentSelectedNewTabs: self.recentSelectedNewTabs,
      managedNewTabs: self.managedNewTabs,
      queueOperation: self.queueOperation.bind(self),
      safeTabMove: self.safeTabMove.bind(self),
      safeTabUpdate: self.safeTabUpdate.bind(self),
      setFocus: self.setFocus.bind(self),
    };
  }

  /**
   * Safe tab move with retry logic for handling drag operations
   */
  public safeTabMove(
    tabId: number,
    moveProperties: any,
    callback?: SafeTabMoveCallback,
    retryCount: number = 0,
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
            }/${maxRetries})`,
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
            }/${maxRetries})`,
          );
          setTimeout(() => {
            this.safeTabUpdate(tabId, updateProperties, retryCount + 1);
          }, retryDelay);
          return;
        }

        // If it's still a dragging error after all retries, just log as debug instead of error
        if (errorMsg?.includes("user may be dragging")) {
          logger.debug(
            `Tab update abandoned after ${maxRetries} retries - user still dragging tab ${tabId}`,
          );
        } else if (errorMsg?.includes("No tab with id")) {
          // Tab was closed before the update completed - expected race condition
          logger.debug(`Tab ${tabId} no longer exists, update skipped`);
        } else {
          // Log other errors normally
          logger.error(`Tab update failed: ${errorMsg}`);
        }
      } else {
        logger.debug(`Tab ${tabId} updated successfully`);
      }
    });
  }

  public async handleNewTab(tabObj: any, windowManager: any): Promise<void> {
    return handleNewTabEvent(this.createRuntime(), tabObj, windowManager);
  }

  public async handleTabClose(
    tabId: number,
    windowId: number,
    windowManager: any,
  ): Promise<void> {
    return handleTabCloseEvent(this.createRuntime(), tabId, windowId, windowManager);
  }

  public async handleTabActivation(info: any, windowManager: any): Promise<void> {
    return handleTabActivationEvent(this.createRuntime(), info, windowManager);
  }

  public async handleTabReplacement(
    newId: number,
    oldId: number,
    windowManager: any,
  ): Promise<void> {
    return handleTabReplacementEvent(this.createRuntime(), newId, oldId, windowManager);
  }

  public async handleTabAttach(tabId: number, attachInfo: any, windowManager: any): Promise<void> {
    return handleTabAttachEvent(this.createRuntime(), tabId, attachInfo, windowManager);
  }

  public async handleTabDetach(tabId: number, detachInfo: any, windowManager: any): Promise<void> {
    return handleTabDetachEvent(this.createRuntime(), tabId, detachInfo, windowManager);
  }

  public async handleTabFlip(tab: any, windowManager: any): Promise<void> {
    return handleTabFlipEvent(this.createRuntime(), tab, windowManager);
  }

  public async openManagedNewTab(_windowManager: any): Promise<void> {
    const settings = settingsManager.getSettings();
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const activeTab = tabs[0];

    if (!activeTab?.windowId) {
      return;
    }

    // Compute the target index BEFORE creation so the tab appears directly at
    // its final position. This avoids any post-create chrome.tabs.move call,
    // which is what causes existing tabs to shift and show a right-slide animation.
    let targetIndex: number | undefined;
    if (settings.ntord && typeof activeTab.index === "number") {
      targetIndex = activeTab.index + 1;
    } else if (settings.reloc) {
      const allTabs = await chrome.tabs.query({ windowId: activeTab.windowId });
      targetIndex = allTabs.length; // new tab will land at the far right
    }

    const createProperties: any = {
      active: false,
      windowId: activeTab.windowId,
    };
    if (targetIndex !== undefined) {
      createProperties.index = targetIndex;
    }
    if (settings.ntord && activeTab.id) {
      createProperties.openerTabId = activeTab.id;
    }

    const createdTab = await chrome.tabs.create(createProperties);
    if (!createdTab?.id || createdTab.windowId == null) {
      return;
    }

    this.managedNewTabs.set(createdTab.id, {
      suppressRelocation: true,
      suppressActivation: settings.ntsel === 1,
    });

    try {
      if (settings.ntsel === 1) {
        await chrome.tabs.update(createdTab.id, { active: true });
      }
    } catch (error) {
      logger.error("Managed new-tab activation failed", error);
      this.managedNewTabs.delete(createdTab.id);
    }
  }
}

// Export singleton instance
export const tabManager = TabManager.getInstance();
