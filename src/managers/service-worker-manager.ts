// Service Worker Manager for FLST Chrome extension

import { logger } from "../utils/logger.js";

export class ServiceWorkerManager {
  private static instance: ServiceWorkerManager;
  private keepAliveInterval: number | undefined;
  private readonly KEEP_ALIVE_INTERVAL = 20000; // 20 seconds

  private constructor() {}

  public static getInstance(): ServiceWorkerManager {
    if (!ServiceWorkerManager.instance) {
      ServiceWorkerManager.instance = new ServiceWorkerManager();
    }
    return ServiceWorkerManager.instance;
  }

  /**
   * Start the keep-alive mechanism to prevent service worker suspension
   */
  public startKeepAlive(): void {
    if (this.keepAliveInterval) {
      this.stopKeepAlive();
    }

    this.keepAliveInterval = setInterval(() => {
      chrome.runtime.getPlatformInfo(() => {
        // This simple API call keeps the service worker alive
        logger.debug("Service worker keep-alive ping");
      });
    }, this.KEEP_ALIVE_INTERVAL);

    logger.debug("Keep-alive mechanism started");
  }

  /**
   * Stop the keep-alive mechanism
   */
  public stopKeepAlive(): void {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = undefined;
      logger.debug("Keep-alive mechanism stopped");
    }
  }

  /**
   * Initialize service worker lifecycle handlers
   */
  public initializeLifecycleHandlers(): void {
    // Handle service worker suspension
    chrome.runtime.onSuspend.addListener(() => {
      logger.debug("Service worker suspending - cleaning up");
      this.stopKeepAlive();
    });

    // Handle service worker suspend cancellation
    chrome.runtime.onSuspendCanceled.addListener(() => {
      logger.debug("Service worker suspend canceled - restarting keep-alive");
      this.startKeepAlive();
    });
  }

  /**
   * Check if keep-alive is active
   */
  public isKeepAliveActive(): boolean {
    return this.keepAliveInterval !== undefined;
  }
}

// Export singleton instance
export const serviceWorkerManager = ServiceWorkerManager.getInstance();
