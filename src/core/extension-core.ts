// Extension Core - Main orchestrator for FLST Chrome extension

import { logger } from "../utils/logger.js";
import { settingsManager } from "../managers/settings-manager.js";
import { serviceWorkerManager } from "../managers/service-worker-manager.js";
import { windowManager } from "../managers/window-manager.js";

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
   * Initialize the extension (event listeners are registered in background.ts)
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

      // Initialize service worker manager (reconciliation callback + keepalive alarm)
      serviceWorkerManager.setReconciliationCallback(() =>
        windowManager.reconcileWithBrowserState(),
      );
      await serviceWorkerManager.startKeepalive();

      this.isInitialized = true;
      logger.log("FLST Chrome extension fully initialized");
    } catch (error) {
      logger.error("Failed to initialize extension", error);
      throw error;
    }
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
