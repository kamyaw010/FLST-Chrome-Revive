// Service Worker Manager for FLST Chrome extension

import { logger } from "../utils/logger.js";
import { storageManager } from "./storage-manager.js";

export class ServiceWorkerManager {
  private static instance: ServiceWorkerManager;
  private isActive: boolean = false;

  private constructor() {}

  public static getInstance(): ServiceWorkerManager {
    if (!ServiceWorkerManager.instance) {
      ServiceWorkerManager.instance = new ServiceWorkerManager();
    }
    return ServiceWorkerManager.instance;
  }

  /**
   * Initialize service worker lifecycle handlers
   */
  public initializeLifecycleHandlers(): void {
    this.isActive = true;

    // Handle service worker startup
    chrome.runtime.onStartup.addListener(() => {
      logger.debug("Service worker started");
      this.isActive = true;
    });

    // Handle service worker suspension
    chrome.runtime.onSuspend.addListener(() => {
      logger.debug("Service worker suspending - persisting state");
      this.isActive = false;
      // State will be saved automatically by the last operation
    });

    // Handle service worker suspend cancellation
    chrome.runtime.onSuspendCanceled.addListener(() => {
      logger.debug("Service worker suspend canceled");
      this.isActive = true;
    });

    // Handle extension installation/update
    chrome.runtime.onInstalled.addListener(async (details) => {
      logger.debug(`Extension ${details.reason}`);

      // Clear old state on fresh install
      if (details.reason === "install") {
        await storageManager.clearTrackingState();
      }

      this.isActive = true;
    });
  }

  /**
   * Check if service worker is active
   */
  public isServiceWorkerActive(): boolean {
    return this.isActive;
  }

  /**
   * Get service worker status
   */
  public getStatus(): { active: boolean; timestamp: number } {
    return {
      active: this.isActive,
      timestamp: Date.now(),
    };
  }
}

// Export singleton instance
export const serviceWorkerManager = ServiceWorkerManager.getInstance();
