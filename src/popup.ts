import { logger } from "./utils/logger.js";
import type { SettingUpdateMessage } from "./types.js";

type VisibleSettingKey = "flip" | "ntsel" | "reloc" | "ntord";

type PopupTextSet = {
  quickSettings: string;
  flipNow: string;
  openManagedNewTab: string;
  reset: string;
  groupTitles: Record<VisibleSettingKey, string>;
  optionLabels: Record<VisibleSettingKey, Record<number, string>>;
};

const VISIBLE_OPTION_KEYS: VisibleSettingKey[] = ["flip", "ntsel", "reloc", "ntord"];

const DEFAULT_VISIBLE_SETTINGS: Record<VisibleSettingKey, number> = {
  flip: 1,
  ntsel: 1,
  reloc: 1,
  ntord: 0,
};

const POPUP_TEXTS: Record<"en" | "zh-CN", PopupTextSet> = {
  en: {
    quickSettings: "Quick Settings",
    flipNow: "Flip To Previous Tab",
    openManagedNewTab: "Open Optimized New Tab",
    reset: "Reset",
    groupTitles: {
      flip: "Tab Flipping",
      reloc: "New Tab Location",
      ntord: "New Tab Sibling Order",
      ntsel: "When a New Tab is Created",
    },
    optionLabels: {
      flip: { 0: "Off", 1: "On" },
      reloc: { 0: "Chrome standard", 1: "Far right" },
      ntord: { 0: "Standard", 1: "Reverse" },
      ntsel: { 0: "Standard", 1: "Select" },
    },
  },
  "zh-CN": {
    quickSettings: "快捷设置",
    flipNow: "切换到上一个标签页",
    openManagedNewTab: "优化方式打开新标签页",
    reset: "恢复默认",
    groupTitles: {
      flip: "标签切换",
      reloc: "新标签页位置",
      ntord: "新标签页同级顺序",
      ntsel: "新标签页创建时",
    },
    optionLabels: {
      flip: { 0: "关闭", 1: "开启" },
      reloc: { 0: "Chrome 默认", 1: "最右侧" },
      ntord: { 0: "默认顺序", 1: "反向" },
      ntsel: { 0: "Chrome 默认", 1: "直接选中" },
    },
  },
};

const SETTING_GROUPS: Array<{
  key: VisibleSettingKey;
  options: Array<{ value: number }>;
}> = [
  {
    key: "flip",
    options: [{ value: 1 }, { value: 0 }],
  },
  {
    key: "reloc",
    options: [{ value: 1 }, { value: 0 }],
  },
  {
    key: "ntord",
    options: [{ value: 1 }, { value: 0 }],
  },
  {
    key: "ntsel",
    options: [{ value: 1 }, { value: 0 }],
  },
];

function getPopupTexts(): PopupTextSet {
  const language = chrome.i18n?.getUILanguage?.() ?? navigator.language ?? "en";
  if (language.toLowerCase().startsWith("zh")) {
    document.documentElement.lang = "zh-CN";
    return POPUP_TEXTS["zh-CN"];
  }

  document.documentElement.lang = "en";
  return POPUP_TEXTS.en;
}

class PopupManager {
  private static instance: PopupManager;
  private readonly texts = getPopupTexts();

  private constructor() {}

  public static getInstance(): PopupManager {
    if (!PopupManager.instance) {
      PopupManager.instance = new PopupManager();
    }
    return PopupManager.instance;
  }

  public async initialize(): Promise<void> {
    this.applyStaticTexts();
    this.renderSettingGroups();
    await this.syncUiFromStorage();
    this.bindGlobalActions();

    const versionElement = document.getElementById("popupVersion");
    if (versionElement) {
      versionElement.textContent = `Rev ${chrome.runtime.getManifest().version}`;
    }
  }

  private applyStaticTexts(): void {
    const subtitle = document.getElementById("popupSubtitle");
    if (subtitle) {
      subtitle.textContent = this.texts.quickSettings;
    }

    const flipNowButton = document.getElementById("flipNow");
    if (flipNowButton) {
      flipNowButton.textContent = this.texts.flipNow;
    }

    const openManagedNewTabButton = document.getElementById("openManagedNewTab");
    if (openManagedNewTabButton) {
      openManagedNewTabButton.textContent = this.texts.openManagedNewTab;
    }

    const resetButton = document.getElementById("resetDefaults");
    if (resetButton) {
      resetButton.textContent = this.texts.reset;
    }
  }

  private renderSettingGroups(): void {
    const container = document.getElementById("settingGroups");
    if (!container) {
      return;
    }

    container.innerHTML = SETTING_GROUPS.map(
      (group) => `
        <section class="setting-card" data-setting="${group.key}">
          <h2>${this.texts.groupTitles[group.key]}</h2>
          <div class="setting-choices">
            ${group.options
              .map(
                (option) => `
                  <button
                    type="button"
                    class="choice-button"
                    data-setting="${group.key}"
                    data-value="${option.value}"
                  >
                    ${this.texts.optionLabels[group.key][option.value]}
                  </button>
                `,
              )
              .join("")}
          </div>
        </section>
      `,
    ).join("");

    container.querySelectorAll<HTMLButtonElement>(".choice-button").forEach((button) => {
      button.addEventListener("click", () => {
        const key = button.dataset.setting as VisibleSettingKey;
        const value = Number(button.dataset.value);
        this.applySetting(key, value);
      });
    });
  }

  private bindGlobalActions(): void {
    document.getElementById("flipNow")?.addEventListener("click", () => {
      this.flipCurrentTab();
    });

    document.getElementById("openManagedNewTab")?.addEventListener("click", () => {
      this.openManagedNewTab();
    });

    document.getElementById("resetDefaults")?.addEventListener("click", () => {
      this.resetDefaults();
    });
  }

  private async syncUiFromStorage(): Promise<void> {
    const settings = await chrome.storage.local.get(VISIBLE_OPTION_KEYS);

    for (const key of VISIBLE_OPTION_KEYS) {
      const currentValue = settings[key] ?? DEFAULT_VISIBLE_SETTINGS[key];
      document
        .querySelectorAll<HTMLButtonElement>(`.choice-button[data-setting="${key}"]`)
        .forEach((button) => {
          button.classList.toggle("is-active", Number(button.dataset.value) === currentValue);
        });
    }
  }

  private async applySetting(key: VisibleSettingKey, value: number): Promise<void> {
    try {
      await chrome.storage.local.set({ [key]: value });

      const message: SettingUpdateMessage = {
        type: "settingUpdate",
        data: {
          source: "popup",
          option: key,
          value,
        },
      };

      await chrome.runtime.sendMessage(message);
      await this.syncUiFromStorage();
    } catch (error) {
      logger.error(`Error applying popup setting ${key}`, error);
    }
  }

  private async resetDefaults(): Promise<void> {
    try {
      await chrome.storage.local.set(DEFAULT_VISIBLE_SETTINGS);

      for (const [key, value] of Object.entries(DEFAULT_VISIBLE_SETTINGS)) {
        const message: SettingUpdateMessage = {
          type: "settingUpdate",
          data: {
            source: "popup-reset",
            option: key,
            value,
          },
        };

        await chrome.runtime.sendMessage(message);
      }

      await this.syncUiFromStorage();
    } catch (error) {
      logger.error("Error resetting popup defaults", error);
    }
  }

  private async flipCurrentTab(): Promise<void> {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const activeTab = tabs[0];

      if (!activeTab?.id || !activeTab.windowId) {
        return;
      }

      await chrome.runtime.sendMessage({
        type: "popupFlipCurrentTab",
        data: {
          id: activeTab.id,
          windowId: activeTab.windowId,
        },
      });

      window.close();
    } catch (error) {
      logger.error("Error flipping current tab from popup", error);
    }
  }

  private async openManagedNewTab(): Promise<void> {
    try {
      await chrome.runtime.sendMessage({ type: "popupOpenManagedNewTab" });
      window.close();
    } catch (error) {
      logger.error("Error opening managed new tab from popup", error);
    }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  PopupManager.getInstance().initialize();
});
