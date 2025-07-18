// Extension Core - Main orchestrator for FLST Chrome extension

import { logger } from "../utils/logger.js";
import { settingsManager } from "../managers/settings-manager.js";
import { serviceWorkerManager } from "../managers/service-worker-manager.js";
import { windowManager } from "../managers/window-manager.js";
import { tabManager } from "../managers/tab-manager.js";
import type { SettingUpdateMessage } from "../types.js";

export class ExtensionCore {
  private static instance: ExtensionCore;
  private isInitialized: boolean = false;

  private constructor() {}

  public static getInstance(): ExtensionCore {
    if (!ExtensionCore.instance) {
      ExtensionCore.instance = new ExtensionCore();
    }
    return ExtensionCore.instance;
  }

  /**
   * Initialize the entire extension
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.warn("Extension already initialized");
      return;
    }

    try {
      logger.log("Starting FLST Chrome extension initialization...");

      // Initialize settings first
      await settingsManager.initialize();

      // Initialize window tracking
      await windowManager.initializeTracking();

      // Set up all event listeners
      this.setupEventListeners();

      // Initialize service worker lifecycle
      serviceWorkerManager.initializeLifecycleHandlers();

      this.isInitialized = true;
      logger.log("FLST Chrome extension fully initialized");
    } catch (error) {
      logger.error("Failed to initialize extension", error);
      throw error;
    }
  }

  /**
   * Set up all Chrome extension event listeners
   */
  private setupEventListeners(): void {
    // Window events
    chrome.windows.onCreated.addListener(this.handleWindowCreated.bind(this));
    chrome.windows.onRemoved.addListener(this.handleWindowRemoved.bind(this));

    // Tab events
    chrome.tabs.onCreated.addListener(this.handleTabCreated.bind(this));
    chrome.tabs.onRemoved.addListener(this.handleTabRemoved.bind(this));
    chrome.tabs.onAttached.addListener(this.handleTabAttached.bind(this));
    chrome.tabs.onDetached.addListener(this.handleTabDetached.bind(this));
    chrome.tabs.onActivated.addListener(this.handleTabActivated.bind(this));
    chrome.tabs.onReplaced.addListener(this.handleTabReplaced.bind(this));

    // Extension events
    chrome.action.onClicked.addListener(this.handleExtensionClicked.bind(this));
    chrome.runtime.onInstalled.addListener(this.handleInstalled.bind(this));
    chrome.runtime.onMessage.addListener(this.handleMessage.bind(this));

    logger.debug("Event listeners set up successfully");
  }

  /**
   * Handle window creation
   */
  private handleWindowCreated(window: any): void {
    // When a new window is created, it might not have tabs populated immediately
    chrome.windows.get(window.id, { populate: true }, async (populatedWindow: any) => {
      if (chrome.runtime.lastError) {
        logger.error(`Error getting window ${window.id}: ${chrome.runtime.lastError.message}`);
        return;
      }
      await windowManager.addWindow(populatedWindow);
    });
  }

  /**
   * Handle window removal
   */
  private async handleWindowRemoved(windowId: number): Promise<void> {
    await windowManager.removeWindow(windowId);
  }

  /**
   * Handle tab creation
   */
  private handleTabCreated(tab: any): void {
    tabManager.handleNewTab(tab, windowManager);
  }

  /**
   * Handle tab removal
   */
  private handleTabRemoved(tabId: number): void {
    tabManager.handleTabClose(tabId, windowManager);
  }

  /**
   * Handle tab attachment
   */
  private handleTabAttached(tabId: number, attachInfo: any): void {
    tabManager.handleTabAttach(tabId, attachInfo, windowManager);
  }

  /**
   * Handle tab detachment
   */
  private handleTabDetached(tabId: number, detachInfo: any): void {
    tabManager.handleTabDetach(tabId, detachInfo, windowManager);
  }

  /**
   * Handle tab activation
   */
  private handleTabActivated(activeInfo: any): void {
    tabManager.handleTabActivation(activeInfo, windowManager);
  }

  /**
   * Handle tab replacement
   */
  private handleTabReplaced(addedTabId: number, removedTabId: number): void {
    tabManager.handleTabReplacement(addedTabId, removedTabId, windowManager);
  }

  /**
   * Handle extension icon clicked (tab flipping)
   */
  private handleExtensionClicked(tab: any): void {
    tabManager.handleTabFlip(tab, windowManager);
  }

  /**
   * Handle extension installation/update
   */
  private handleInstalled(details: any): void {
    const manifest = chrome.runtime.getManifest();
    if (!manifest?.name?.startsWith("FLST Chrome")) return;

    logger.log(`Extension ${details.reason}: ${manifest.name} v${manifest.version}`);
    // No longer opening tutorial pages - just log the event
  }

  /**
   * Handle messages from options page and other parts
   */
  private handleMessage(
    message: SettingUpdateMessage,
    sender: any,
    sendResponse: (response: any) => void
  ): boolean {
    if (message.type === "settingUpdate") {
      settingsManager
        .handleSettingUpdateMessage(message)
        .then(() => sendResponse({ success: true }))
        .catch((error) => {
          logger.error("Error handling setting update", error);
          sendResponse({ success: false, error: error.message });
        });
      return true; // Keep message channel open for async response
    }

    return false;
  }

  /**
   * Get extension status
   */
  public getStatus(): {
    initialized: boolean;
    serviceWorkerActive: boolean;
    trackingStats: any;
    settings: any;
  } {
    return {
      initialized: this.isInitialized,
      serviceWorkerActive: serviceWorkerManager.isServiceWorkerActive(),
      trackingStats: windowManager.getTrackingStats(),
      settings: settingsManager.getSettings(),
    };
  }

  /**
   * Shutdown the extension gracefully
   */
  public async shutdown(): Promise<void> {
    logger.log("Shutting down FLST Chrome extension...");
    await windowManager.clearTracking();
    this.isInitialized = false;
    logger.log("Extension shutdown complete");
  }
}

// Export singleton instance
export const extensionCore = ExtensionCore.getInstance();
