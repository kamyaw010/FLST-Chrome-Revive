// Settings Manager for FLST Chrome extension

import { logger } from "../utils/logger.js";
import { storageManager } from "./storage-manager.js";
import type { SettingUpdateMessage } from "../types.js";

export interface FlstSettings {
  flip: number; // Tab flipping: 1 = on (last selected), 0 = off (left tab)
  reloc: number; // New tab location: 1 = far right, 0 = chrome standard
  log: boolean; // Enable/disable logging
}

export class SettingsManager {
  private static instance: SettingsManager;
  private settings: FlstSettings = {
    flip: 1,
    reloc: 1,
    log: false,
  };

  private constructor() {}

  public static getInstance(): SettingsManager {
    if (!SettingsManager.instance) {
      SettingsManager.instance = new SettingsManager();
    }
    return SettingsManager.instance;
  }

  /**
   * Initialize all settings from storage
   */
  public async initialize(): Promise<void> {
    try {
      this.settings.flip = await storageManager.initializeSetting("flip", 1);
      this.settings.reloc = await storageManager.initializeSetting("reloc", 1);
      this.settings.log = await storageManager.initializeSetting("log", false);

      // Apply logging setting
      logger.setEnabled(this.settings.log);

      logger.debug("Settings initialized successfully");
    } catch (error) {
      logger.error("Error initializing settings", error);
    }
  }

  /**
   * Update a setting
   */
  public async updateSetting(
    key: keyof FlstSettings,
    value: any,
    source: string = "unknown"
  ): Promise<void> {
    try {
      const originalValue = this.settings[key];
      await storageManager.setSetting(key, value);

      // Update local cache
      (this.settings as any)[key] = value;

      // Apply special settings
      if (key === "log") {
        logger.setEnabled(value);
      }

      logger.debug(`${source}: ${key} => was ${originalValue}, now ${value}`);
    } catch (error) {
      logger.error(`Error updating setting ${key}`, error);
      throw error;
    }
  }

  /**
   * Get current settings
   */
  public getSettings(): FlstSettings {
    return { ...this.settings };
  }

  /**
   * Get a specific setting
   */
  public getSetting<K extends keyof FlstSettings>(key: K): FlstSettings[K] {
    return this.settings[key];
  }

  /**
   * Handle setting update messages from options page
   */
  public async handleSettingUpdateMessage(message: SettingUpdateMessage): Promise<void> {
    const { source, option, value } = message.data;

    if (option in this.settings) {
      await this.updateSetting(option as keyof FlstSettings, value, source);
    } else {
      logger.warn(`Unknown setting: ${option}`);
    }
  }

  /**
   * Toggle logging on/off
   */
  public async toggleLogging(): Promise<void> {
    await this.updateSetting("log", !this.settings.log, "toggle");
  }

  /**
   * Export settings for debugging
   */
  public exportSettings(): string {
    return JSON.stringify(this.settings, null, 2);
  }
}

// Export singleton instance
export const settingsManager = SettingsManager.getInstance();
