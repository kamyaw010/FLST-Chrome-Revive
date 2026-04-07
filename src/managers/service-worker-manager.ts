// Service Worker Manager for FLST Chrome extension
// Uses chrome.alarms API for keepalive (persists across service worker restarts)
// Event listeners are registered synchronously in background.ts

import { logger } from "../utils/logger.js";
import { storageManager } from "./storage-manager.js";

export class ServiceWorkerManager {
  private static instance: ServiceWorkerManager;
  private isActive: boolean = false;
  private lastActivationTime: number = 0;
  private reconciliationCallback: (() => Promise<void>) | null = null;
  private static readonly KEEPALIVE_ALARM_NAME = "flst-keepalive";
  private static readonly KEEPALIVE_PERIOD_MINUTES = 0.5; // 30 seconds (minimum for chrome.alarms)

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
   * Start the keepalive alarm (replaces setInterval which doesn't survive service worker restarts)
   */
  public async startKeepalive(): Promise<void> {
    this.isActive = true;
    this.lastActivationTime = Date.now();

    chrome.alarms.create(ServiceWorkerManager.KEEPALIVE_ALARM_NAME, {
      periodInMinutes: ServiceWorkerManager.KEEPALIVE_PERIOD_MINUTES,
    });

    logger.debug(
      `Keepalive alarm created with ${ServiceWorkerManager.KEEPALIVE_PERIOD_MINUTES * 60}s period`,
    );
  }

  /**
   * Handle keepalive alarm firing - called from background.ts
   */
  public async handleKeepaliveAlarm(): Promise<void> {
    const now = Date.now();
    const timeSinceLastActivation = now - this.lastActivationTime;

    this.lastActivationTime = now;
    this.isActive = true;

    // If significantly more time passed than the alarm period, the service worker was likely dormant
    if (timeSinceLastActivation > 35000) {
      logger.debug(
        `Keepalive detected dormancy: ${timeSinceLastActivation}ms since last activation - triggering reconciliation`,
      );
      await this.triggerReconciliation();
    } else {
      logger.debug(`Keepalive: service worker active (${timeSinceLastActivation}ms since last)`);
    }
  }

  /**
   * Handle service worker startup event - called from background.ts
   */
  public async handleReactivation(): Promise<void> {
    const now = Date.now();
    const timeSinceLastActivation = now - this.lastActivationTime;

    this.isActive = true;
    this.lastActivationTime = now;

    // Ensure keepalive alarm is running
    const existingAlarm = await chrome.alarms.get(ServiceWorkerManager.KEEPALIVE_ALARM_NAME);
    if (!existingAlarm) {
      await this.startKeepalive();
    }

    if (timeSinceLastActivation > 10000) {
      logger.debug(
        `Service worker reactivated after ${timeSinceLastActivation}ms - triggering reconciliation`,
      );
      await this.triggerReconciliation();
    }
  }

  /**
   * Handle service worker suspension - called from background.ts
   * Must be fast - Chrome gives limited time before suspending
   */
  public handleSuspend(): void {
    this.isActive = false;
    // Force immediate save of any pending state before suspension
    storageManager.flushTrackingState().catch((error) => {
      logger.error("Error flushing state during suspension", error);
    });
  }

  /**
   * Handle suspension cancellation - called from background.ts
   */
  public async handleSuspendCanceled(): Promise<void> {
    this.isActive = true;
    this.lastActivationTime = Date.now();
    logger.debug("Suspend canceled - triggering reconciliation");
    await this.triggerReconciliation();
  }

  /**
   * Trigger reconciliation with browser state
   */
  private async triggerReconciliation(): Promise<void> {
    if (!this.reconciliationCallback) return;

    // Small delay to allow any pending operations to complete
    await new Promise((resolve) => setTimeout(resolve, 250));

    try {
      await this.reconciliationCallback();
    } catch (error) {
      logger.error("Error during reconciliation after reactivation", error);
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
