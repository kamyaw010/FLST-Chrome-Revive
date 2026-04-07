//
// FLST Chrome <<>> Focus Last Selected Tab <<>> Rev 3.3.0
//
// FLST provides natural / MRU tab ordering, plus Options for
// Tab-Flipping, New-Tab-Select, and New-Tab-Location.
//
// Manifest V3 service worker entry point.
// ALL event listeners MUST be registered synchronously at the top level
// to survive service worker restarts.
//

import { extensionCore } from "./core/extension-core.js";
import { logger } from "./utils/logger.js";
import { windowManager } from "./managers/window-manager.js";
import { tabManager } from "./managers/tab-manager.js";
import { settingsManager } from "./managers/settings-manager.js";
import { serviceWorkerManager } from "./managers/service-worker-manager.js";
import { storageManager } from "./managers/storage-manager.js";

// =====================================================================
// Initialization promise - ensures init completes before event handling
// =====================================================================
let initPromise: Promise<void> | null = null;

function ensureInitialized(): Promise<void> {
  if (!initPromise) {
    initPromise = extensionCore.initialize().catch((error) => {
      logger.error("Failed to initialize FLST Chrome extension", error);
      console.error("Critical error during extension initialization:", error);
      initPromise = null; // Allow retry on next event
      throw error;
    });
  }
  return initPromise;
}

// =====================================================================
// ALL event listeners registered synchronously (MV3 requirement)
// =====================================================================

// --- Window events ---
chrome.windows.onCreated.addListener((window) => {
  ensureInitialized().then(() => {
    chrome.windows.get(window.id, { populate: true }, async (populatedWindow: any) => {
      if (chrome.runtime.lastError) {
        logger.error(`Error getting window ${window.id}: ${chrome.runtime.lastError.message}`);
        return;
      }
      await windowManager.addWindow(populatedWindow);
    });
  });
});

chrome.windows.onRemoved.addListener((windowId) => {
  ensureInitialized().then(() => windowManager.removeWindow(windowId));
});

// --- Tab events ---
chrome.tabs.onCreated.addListener((tab) => {
  ensureInitialized().then(() => {
    logger.debug(`Tab created event fired for tabId ${tab.id}`);
    tabManager.handleNewTab(tab, windowManager);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  ensureInitialized().then(() => {
    logger.debug(`Tab removed event fired for tabId ${tabId}`);
    tabManager.handleTabClose(tabId, windowManager);
  });
});

chrome.tabs.onAttached.addListener((tabId, attachInfo) => {
  ensureInitialized().then(() => tabManager.handleTabAttach(tabId, attachInfo, windowManager));
});

chrome.tabs.onDetached.addListener((tabId, detachInfo) => {
  ensureInitialized().then(() => tabManager.handleTabDetach(tabId, detachInfo, windowManager));
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  ensureInitialized().then(() => {
    logger.debug(`Tab activated event fired for tabId ${activeInfo.tabId}`);
    tabManager.handleTabActivation(activeInfo, windowManager);
  });
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  ensureInitialized().then(() =>
    tabManager.handleTabReplacement(addedTabId, removedTabId, windowManager),
  );
});

// --- Extension action ---
chrome.action.onClicked.addListener((tab) => {
  ensureInitialized().then(() => {
    tabManager.handleTabFlip(tab, windowManager).catch((error) => {
      logger.error("Error handling tab flip", error);
    });
  });
});

// --- Runtime events ---
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    await storageManager.clearTrackingState();
  }

  await ensureInitialized();

  const manifest = chrome.runtime.getManifest();
  if (manifest?.name?.startsWith("FLST Chrome")) {
    logger.log(`Extension ${details.reason}: ${manifest.name} v${manifest.version}`);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Handle ping immediately (no init needed)
  if (message.type === "flst-ping") {
    sendResponse({ type: "flst-pong", timestamp: Date.now() });
    return true;
  }

  // Handle setting updates
  if (message.type === "settingUpdate") {
    ensureInitialized().then(() => {
      settingsManager
        .handleSettingUpdateMessage(message)
        .then(() => sendResponse({ success: true }))
        .catch((error) => {
          logger.error("Error handling setting update", error);
          sendResponse({ success: false, error: error.message });
        });
    });
    return true;
  }

  return false;
});

// --- Service worker lifecycle ---
chrome.runtime.onStartup.addListener(() => {
  logger.debug("Service worker started (onStartup)");
  ensureInitialized().then(() => serviceWorkerManager.handleReactivation());
});

chrome.runtime.onSuspend.addListener(() => {
  logger.debug("Service worker suspending - persisting state");
  serviceWorkerManager.handleSuspend();
});

chrome.runtime.onSuspendCanceled.addListener(() => {
  logger.debug("Service worker suspend canceled");
  ensureInitialized().then(() => serviceWorkerManager.handleSuspendCanceled());
});

// --- Alarms for keepalive (persists across service worker restarts) ---
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "flst-keepalive") {
    ensureInitialized().then(() => serviceWorkerManager.handleKeepaliveAlarm());
  }
});

// =====================================================================
// Start initialization
// =====================================================================
ensureInitialized();

// Export for debugging purposes
(globalThis as any).FLST_DEBUG = {
  getStatus: () => extensionCore.getStatus(),
  shutdown: () => extensionCore.shutdown(),
  reinitialize: () => {
    initPromise = null;
    return ensureInitialized();
  },
};
