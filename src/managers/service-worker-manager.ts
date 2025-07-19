// Service Worker Manager for FLST Chrome extension

import { logger } from "../utils/logger.js";
import { storageManager } from "./storage-manager.js";

export class ServiceWorkerManager {
  private static instance: ServiceWorkerManager;
  private isActive: boolean = false;
  private lastActivationTime: number = 0;
  private reconciliationCallback: (() => Promise<void>) | null = null;
  private readonly PING_MESSAGE_TYPE = "flst-ping";
  private readonly PONG_MESSAGE_TYPE = "flst-pong";
  private readonly REACTIVATION_CHECK_INTERVAL = 5000; // 5 seconds
  private reactivationCheckTimer: number | null = null;

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

    // Set up message listener for ping/pong reactivation detection
    this.setupMessageListener();

    // Start periodic reactivation checking
    this.startReactivationMonitoring();

    // Handle service worker startup
    chrome.runtime.onStartup.addListener(async () => {
      logger.debug("Service worker started");
      await this.handleReactivation();
    });

    // Handle service worker suspension
    chrome.runtime.onSuspend.addListener(() => {
      logger.debug("Service worker suspending - persisting state");
      this.isActive = false;
      this.stopReactivationMonitoring();
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

    // Restart reactivation monitoring if it was stopped
    this.startReactivationMonitoring();

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
   * Setup message listener for ping/pong reactivation detection
   */
  private setupMessageListener(): void {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === this.PING_MESSAGE_TYPE) {
        logger.debug("Ping received - service worker is active");

        // Update last activation time
        this.lastActivationTime = Date.now();
        this.isActive = true;

        // Send pong response
        sendResponse({ type: this.PONG_MESSAGE_TYPE, timestamp: Date.now() });

        // Check if this ping indicates a reactivation
        const timeSinceLastActivation = Date.now() - this.lastActivationTime;
        if (timeSinceLastActivation > 5000) {
          this.handleReactivation();
        }

        return true; // Keep message channel open for async response
      }
    });
  }

  /**
   * Start periodic reactivation monitoring
   */
  private startReactivationMonitoring(): void {
    // Clear any existing timer
    this.stopReactivationMonitoring();

    // Set up periodic self-ping to detect reactivation
    this.reactivationCheckTimer = setInterval(async () => {
      try {
        const pingStartTime = Date.now();

        // Send ping to ourselves to test if service worker is responsive
        const response = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage(
            { type: this.PING_MESSAGE_TYPE, timestamp: pingStartTime },
            (response) => {
              if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
              } else {
                resolve(response);
              }
            }
          );
        });

        // If we got a response, update activation time
        if (response && typeof response === "object" && "type" in response) {
          this.lastActivationTime = Date.now();
          this.isActive = true;
        }
      } catch (error) {
        // If ping fails, it might indicate service worker was dormant
        logger.debug("Self-ping failed - service worker may have been dormant");

        // Trigger reactivation handling
        await this.handleReactivation();
      }
    }, this.REACTIVATION_CHECK_INTERVAL);

    logger.debug(
      `Reactivation monitoring started with ${this.REACTIVATION_CHECK_INTERVAL}ms interval`
    );
  }

  /**
   * Stop reactivation monitoring
   */
  private stopReactivationMonitoring(): void {
    if (this.reactivationCheckTimer) {
      clearInterval(this.reactivationCheckTimer);
      this.reactivationCheckTimer = null;
      logger.debug("Reactivation monitoring stopped");
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

  /**
   * Stop reactivation monitoring (for cleanup)
   */
  public stopMonitoring(): Promise<void> {
    this.stopReactivationMonitoring();
    logger.debug("Service worker monitoring stopped");
    return Promise.resolve();
  }
}

// Export singleton instance
export const serviceWorkerManager = ServiceWorkerManager.getInstance();
