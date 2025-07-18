// Options page script for FLST Chrome extension

import { logger } from "./utils/logger.js";
import type { SettingUpdateMessage } from "./types.js";

class OptionsManager {
  private static instance: OptionsManager;

  private constructor() {}

  public static getInstance(): OptionsManager {
    if (!OptionsManager.instance) {
      OptionsManager.instance = new OptionsManager();
    }
    return OptionsManager.instance;
  }

  /**
   * Handle option update when user changes settings
   */
  public async handleOptionUpdate(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const value = parseInt(input.value);

    try {
      // Store the setting
      await chrome.storage.local.set({ [input.name]: value });

      // Send message to the background service worker
      const message: SettingUpdateMessage = {
        type: "settingUpdate",
        data: {
          source: "options-page",
          option: input.name,
          value: value,
        },
      };

      await chrome.runtime.sendMessage(message);
      logger.log(`Setting ${input.name} updated to ${value}`);
    } catch (error) {
      logger.error(`Error updating option ${input.name}`, error);
    }
  }

  /**
   * Initialize the options page
   */
  public async initialize(): Promise<void> {
    try {
      const inputElements = document.getElementsByTagName("input");
      if (inputElements.length === 0) {
        logger.warn("No input elements found on options page");
        return;
      }

      // Get all settings at once
      const settings = await chrome.storage.local.get(["flip", "ntsel", "reloc", "log"]);

      // Set default values if undefined
      const defaults = {
        flip: 1,
        ntsel: 1,
        reloc: 1,
        log: 0, // 0 = off, 1 = on
      };

      // Apply settings or defaults to radio buttons
      for (let i = 0; i < inputElements.length; i++) {
        const input = inputElements[i];
        if (input.type !== "radio") continue;

        const settingValue = settings[input.name] ?? defaults[input.name as keyof typeof defaults];
        input.checked = parseInt(input.value) === settingValue;
        input.addEventListener("change", (e) => this.handleOptionUpdate(e));
      }

      logger.log("Options page initialized successfully");
    } catch (error) {
      logger.error("Error initializing options page", error);
    }
  }

  /**
   * Get current option values for display
   */
  public async getCurrentSettings(): Promise<Record<string, any>> {
    try {
      return await chrome.storage.local.get(["flip", "ntsel", "reloc", "log"]);
    } catch (error) {
      logger.error("Error getting current settings", error);
      return {};
    }
  }

  /**
   * Reset all settings to defaults
   */
  public async resetToDefaults(): Promise<void> {
    try {
      const defaults = {
        flip: 1,
        ntsel: 1,
        reloc: 1,
        log: 0,
      };

      await chrome.storage.local.set(defaults);

      // Update UI to reflect defaults
      const inputElements = document.getElementsByTagName("input");
      for (let i = 0; i < inputElements.length; i++) {
        const input = inputElements[i];
        if (input.type !== "radio") continue;

        const defaultValue = defaults[input.name as keyof typeof defaults];
        input.checked = parseInt(input.value) === defaultValue;
      }

      // Notify background script
      for (const [key, value] of Object.entries(defaults)) {
        const message: SettingUpdateMessage = {
          type: "settingUpdate",
          data: {
            source: "options-reset",
            option: key,
            value: value,
          },
        };
        await chrome.runtime.sendMessage(message);
      }

      logger.log("Settings reset to defaults");
    } catch (error) {
      logger.error("Error resetting settings", error);
    }
  }
}

// Initialize when the DOM is ready
document.addEventListener("DOMContentLoaded", () => {
  const optionsManager = OptionsManager.getInstance();
  optionsManager.initialize();

  // Add reset button if it exists
  const resetButton = document.getElementById("resetDefaults");
  if (resetButton) {
    resetButton.addEventListener("click", () => {
      optionsManager.resetToDefaults();
    });
  }
});

// Export for debugging
(globalThis as any).FLST_OPTIONS_DEBUG = {
  getCurrentSettings: () => OptionsManager.getInstance().getCurrentSettings(),
  resetToDefaults: () => OptionsManager.getInstance().resetToDefaults(),
};
