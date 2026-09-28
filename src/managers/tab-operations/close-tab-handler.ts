import { logger } from "../../utils/logger.js";
import { storageManager } from "../storage-manager.js";
import { settingsManager } from "../settings-manager.js";
import { SkipActivationReason } from "../../types.js";
import { getMostRecentTabExcluding, getMostRecentTabId } from "./mru-utils.js";
import type { TabManagerRuntime } from "./runtime.js";

export async function handleTabCloseEvent(
  runtime: TabManagerRuntime,
  tabId: number,
  windowId: number,
  windowManager: any,
): Promise<void> {
  logger.debug(`TabManager: handleTabClose called for tabId ${tabId} in window ${windowId}`);

  // Single scan: find the tab and its window in one pass.
  let foundWindowId: number | undefined;
  let foundInfo: { tabarr: any; tabloc: number } | null = null;

  for (const tracker of windowManager.getAllTrackers()) {
    const idx = tracker.tabarr.findIndex((e: any) => e.tabId === tabId);
    if (idx !== -1) {
      foundWindowId = tracker.wid;
      foundInfo = { tabarr: tracker.tabarr, tabloc: idx };
      break;
    }
  }

  // After long idle periods the service worker may restart just in time for the
  // close event, and by the time initializeTracking() queries the browser state
  // the closed tab is already gone.  In that case the tab won't be found in any
  // tracker.  Fall back to the windowId from chrome.tabs.onRemoved so we can
  // still determine the MRU next tab from the window's tracker.
  if (!foundInfo || foundWindowId === undefined) {
    logger.debug(`CloseTab: tabid ${tabId} not found in any tracker, using removeInfo.windowId ${windowId}`);
    foundWindowId = windowId;

    // If we can't find it by scanning, get the window tracker directly.
    const tracker = windowManager.getWindowTracker(windowId);
    if (!tracker || tracker.tabarr.length === 0) {
      logger.debug(`CloseTab: window ${windowId} has no trackable tabs either`);
      return;
    }

    // The closed tab is already gone from the tracker (reconciliation removed it
    // during SW restart).  Find the most recent remaining tab.
    const nextTabId = getMostRecentTabId(tracker.tabarr);
    if (nextTabId !== null && settingsManager.getSettings().flip) {
      logger.debug(
        `CloseTab: Fallback MRU target for window ${windowId} is tab ${nextTabId}`,
      );
      runtime.skipNextActivation = {
        reason: SkipActivationReason.CLOSE_TAB,
        expectedTabId: nextTabId,
      };
      runtime.lastCloseInfo = {
        windowId,
        expectedTabId: nextTabId,
        timestamp: Date.now(),
      };
    }

    // Still run through the queue to persist state
    return runtime.queueOperation(windowId, async () => {
      void storageManager.saveTrackingState(windowManager.getAllTrackers(), true).catch((error) => {
        logger.error("CloseTab: Failed to persist tracking state", error);
      });
    });
  }

  const tabarr = foundInfo.tabarr;
  const tabloc = foundInfo.tabloc;
  const settings = settingsManager.getSettings();

  // Set correction state SYNCHRONOUSLY before entering the operation queue.
  // Chrome fires onActivated very shortly after onRemoved. If we set
  // skipNextActivation inside queueOperation (async), a queued new-tab
  // operation could delay us past the point where onActivated is processed,
  // causing the activation handler to see null and let the wrong tab through.
  // Setting it here guarantees onActivated always finds the correct target.
  // Setting correction state is only valid when the closed tab was the active
  // one, because that is the only case where Chrome fires onActivated afterwards.
  // When a background tab is closed, a stale skipNextActivation entry would
  // hijack the user's next manual tab switch (forcing focus back to the MRU
  // target of the close). Use the last known active tab when available and fall
  // back to the MRU leader (the active tab is normally the most recent one).
  const knownActiveTabId = runtime.lastKnownActiveTabIds.get(foundWindowId);
  const closedWasActive =
    knownActiveTabId !== undefined
      ? knownActiveTabId === tabId
      : getMostRecentTabId(tabarr) === tabId;

  if (tabarr.length > 1 && settings.flip && closedWasActive) {
    const nextTabId = getMostRecentTabExcluding(tabarr, tabId);
    if (nextTabId) {
      const currentActiveTabId = runtime.lastKnownActiveTabIds.get(foundWindowId);
      if (currentActiveTabId === nextTabId) {
        logger.debug(
          `CloseTab: Expected tab ${nextTabId} is already active - no correction needed`,
        );
      } else {
        logger.debug(
          `CloseTab: Tab flipping ON - setting correction target ${nextTabId} for onActivated`,
        );
        runtime.skipNextActivation = {
          reason: SkipActivationReason.CLOSE_TAB,
          expectedTabId: nextTabId,
        };
        runtime.lastCloseInfo = {
          windowId: foundWindowId,
          expectedTabId: nextTabId,
          timestamp: Date.now(),
        };
      }
    }
  } else {
    logger.debug(
      `CloseTab: No correction needed (flip=${settings.flip}, closedWasActive=${closedWasActive}, remaining=${tabarr.length})`,
    );
  }

  return runtime.queueOperation(foundWindowId, async () => {
    logger.debug(`CloseTab: tabid ${tabId}, flip option: ${settings.flip}`);
    if (logger.isLoggingEnabled()) {
      logger.debug(`CloseTab: (before) [${tabarr.map((entry: any) => entry.tabId)}]`);
    }

    tabarr.splice(tabloc, 1);
    const recentNewTab = runtime.recentSelectedNewTabs.get(foundWindowId);
    if (recentNewTab?.tabId === tabId) {
      runtime.recentSelectedNewTabs.delete(foundWindowId);
    }
    if (logger.isLoggingEnabled()) {
      logger.debug(`CloseTab: (after) [${tabarr.map((entry: any) => entry.tabId)}]`);
    }

    void storageManager.saveTrackingState(windowManager.getAllTrackers(), true).catch((error) => {
      logger.error("CloseTab: Failed to persist tracking state", error);
    });
  });
}
