// Service Worker Manager for FLST Chrome extension

import { logger } from "../utils/logger.js";
import { storageManager } from "./storage-manager.js";

export class ServiceWorkerManager {
  private static instance: ServiceWorkerManager;
  private isActive: boolean = false;
  private lastActivationTime: number = 0;
  private reconciliationCallback: (() => Promise<void>) | null = null;

  private constructor() {}

  public static getInstance(): ServiceWorkerManager {
    if (!ServiceWorkerManager.instance) {
      ServiceWorkerManager.instance = new ServiceWorkerManager();
    }
    return ServiceWorkerManager.instance;
  }

  /**
   * Set callback to be called when service worker reactivates
   */
  public setReconciliationCallback(callback: () => Promise<void>): void {
    this.reconciliationCallback = callback;
  }

  /**
   * Initialize service worker lifecycle handlers
   */
  public initializeLifecycleHandlers(): void {
    this.isActive = true;
    this.lastActivationTime = Date.now();

    // Handle service worker startup
    chrome.runtime.onStartup.addListener(async () => {
      logger.debug("Service worker started");
      await this.handleReactivation();
    });

    // Handle service worker suspension
    chrome.runtime.onSuspend.addListener(() => {
      logger.debug("Service worker suspending - persisting state");
      this.isActive = false;
      // State will be saved automatically by the last operation
    });

    // Handle service worker suspend cancellation
    chrome.runtime.onSuspendCanceled.addListener(async () => {
      logger.debug("Service worker suspend canceled");
      await this.handleReactivation();
    });

    // Handle extension installation/update
    chrome.runtime.onInstalled.addListener(async (details) => {
      logger.debug(`Extension ${details.reason}`);

      // Clear old state on fresh install
      if (details.reason === "install") {
        await storageManager.clearTrackingState();
      }

      await this.handleReactivation();
    });
  }

  /**
   * Handle service worker reactivation
   */
  private async handleReactivation(): Promise<void> {
    const now = Date.now();
    const timeSinceLastActivation = now - this.lastActivationTime;

    this.isActive = true;
    this.lastActivationTime = now;

    // If more than 5 seconds have passed since last activation, trigger reconciliation
    if (timeSinceLastActivation > 5000) {
      logger.debug(
        `Service worker reactivated after ${timeSinceLastActivation}ms - triggering reconciliation`
      );

      // Small delay to allow any pending operations to complete
      setTimeout(async () => {
        if (this.reconciliationCallback) {
          try {
            await this.reconciliationCallback();
          } catch (error) {
            logger.error("Error during reconciliation after reactivation", error);
          }
        }
      }, 100);
    }
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
  public getStatus(): { active: boolean; timestamp: number; lastActivation: number } {
    return {
      active: this.isActive,
      timestamp: Date.now(),
      lastActivation: this.lastActivationTime,
    };
  }
}

// Export singleton instance
export const serviceWorkerManager = ServiceWorkerManager.getInstance();
