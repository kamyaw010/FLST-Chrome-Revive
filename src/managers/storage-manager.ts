// Storage Manager for FLST Chrome extension

import { logger } from "../utils/logger.js";
import type { StorageData, TabTracker, StoredTrackingState } from "../types.js";

export class StorageManager {
  private static instance: StorageManager;

  private constructor() {}

  public static getInstance(): StorageManager {
    if (!StorageManager.instance) {
      StorageManager.instance = new StorageManager();
    }
    return StorageManager.instance;
  }

  /**
   * Get a setting from storage with optional default value
   */
  public async getSetting<T = any>(key: string, defaultValue?: T): Promise<T> {
    try {
      const result = await chrome.storage.local.get(key);
      const value = result[key] ?? defaultValue;
      return value;
    } catch (error) {
      logger.error(`Error getting setting ${key}`, error);
      return defaultValue as T;
    }
  }

  /**
   * Set a setting in storage
   */
  public async setSetting(key: string, value: any): Promise<void> {
    try {
      await chrome.storage.local.set({ [key]: value });
    } catch (error) {
      logger.error(`Error setting ${key}`, error);
      throw error;
    }
  }

  /**
   * Get multiple settings at once
   */
  public async getSettings(keys: string[]): Promise<StorageData> {
    try {
      return await chrome.storage.local.get(keys);
    } catch (error) {
      logger.error(`Error getting settings`, error);
      return {};
    }
  }

  /**
   * Set multiple settings at once
   */
  public async setSettings(data: StorageData): Promise<void> {
    try {
      await chrome.storage.local.set(data);
    } catch (error) {
      logger.error(`Error setting settings`, error);
      throw error;
    }
  }

  /**
   * Initialize a setting with default value if not exists
   */
  public async initializeSetting(key: string, defaultValue: any): Promise<any> {
    try {
      const result = await chrome.storage.local.get(key);
      const existingValue = result[key];

      if (existingValue === undefined) {
        await this.setSetting(key, defaultValue);
        logger.debug(`Initialized setting ${key} with default value: ${defaultValue}`);
        return defaultValue;
      }

      const value = Number(existingValue);
      logger.debug(`Loaded setting ${key}: ${value}`);
      return value;
    } catch (error) {
      logger.error(`Error initializing setting ${key}`, error);
      return defaultValue;
    }
  }

  /**
   * Save tracking state to storage with timestamp
   */
  public async saveTrackingState(trackingState: TabTracker[]): Promise<void> {
    try {
      const stateData = {
        trackingState,
        timestamp: Date.now(),
        version: "3.0.3",
      };
      await this.setSetting("flstState", stateData);
      logger.debug(`Tracking state saved: ${trackingState.length} windows`);
    } catch (error) {
      logger.error("Error saving tracking state", error);
    }
  }

  /**
   * Load tracking state from storage
   */
  public async loadTrackingState(): Promise<TabTracker[]> {
    try {
      const stateData = (await this.getSetting("flstState", null)) as StoredTrackingState | null;
      if (!stateData || !stateData.trackingState || !Array.isArray(stateData.trackingState)) {
        logger.debug("No valid tracking state found in storage");
        return [];
      }

      const age = Date.now() - (stateData.timestamp || 0);
      const maxAge = 24 * 60 * 60 * 1000; // 24 hours

      if (age > maxAge) {
        logger.debug("Tracking state too old, ignoring");
        return [];
      }

      logger.debug(
        `Loaded tracking state: ${stateData.trackingState.length} windows, age: ${Math.round(
          age / 1000
        )}s`
      );
      return stateData.trackingState;
    } catch (error) {
      logger.error("Error loading tracking state", error);
      return [];
    }
  }

  /**
   * Clear tracking state from storage
   */
  public async clearTrackingState(): Promise<void> {
    try {
      await this.setSetting("flstState", null);
      logger.debug("Tracking state cleared");
    } catch (error) {
      logger.error("Error clearing tracking state", error);
    }
  }
}

// Export singleton instance
export const storageManager = StorageManager.getInstance();
