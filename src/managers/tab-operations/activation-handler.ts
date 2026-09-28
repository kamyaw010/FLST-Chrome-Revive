import { logger } from "../../utils/logger.js";
import { storageManager } from "../storage-manager.js";
import { SkipActivationReason } from "../../types.js";
import { findTabInMRU, getMostRecentTabId, updateTabTimestamp } from "./mru-utils.js";
import type { TabManagerRuntime } from "./runtime.js";

export async function handleTabActivationEvent(
  runtime: TabManagerRuntime,
  info: any,
  windowManager: any,
): Promise<void> {
  if (info.windowId && info.tabId) {
    runtime.lastKnownActiveTabIds.set(info.windowId, info.tabId);

    const recentNewTab = runtime.recentSelectedNewTabs.get(info.windowId);
    if (recentNewTab && recentNewTab.tabId !== info.tabId) {
      runtime.recentSelectedNewTabs.delete(info.windowId);
    }
  }

  if (runtime.skipNextActivation) {
    const skipInfo = runtime.skipNextActivation;
    logger.debug(`Shuffle: skip => ${skipInfo.reason}`);

    runtime.skipNextActivation = null;
    runtime.lastCloseInfo = null;

    if (skipInfo.reason === SkipActivationReason.CLOSE_TAB && skipInfo.expectedTabId) {
      if (skipInfo.expectedTabId === info.tabId) {
        logger.debug(
          `Shuffle: Expected tab ${skipInfo.expectedTabId} activated after close - allowing`,
        );
      } else {
        logger.debug(
          `Shuffle: Unexpected tab ${info.tabId} activated, expected ${skipInfo.expectedTabId} - correcting`,
        );
        runtime.setFocus(skipInfo.expectedTabId, SkipActivationReason.CLOSE_TAB_CORRECTION);
        return;
      }
    } else {
      return;
    }
  } else if (runtime.lastCloseInfo) {
    const closeInfo = runtime.lastCloseInfo;
    const elapsed = Date.now() - closeInfo.timestamp;

    if (elapsed < 2000 && closeInfo.windowId === info.windowId) {
      logger.debug(
        `Shuffle: skipNextActivation was null but close detected ${elapsed}ms ago - correcting to tab ${closeInfo.expectedTabId}`,
      );
      runtime.lastCloseInfo = null;

      if (closeInfo.expectedTabId !== info.tabId) {
        runtime.setFocus(closeInfo.expectedTabId, SkipActivationReason.CLOSE_TAB_CORRECTION);
        return;
      }
    } else {
      runtime.lastCloseInfo = null;
    }
  }

  return runtime.queueOperation(info.windowId, async () => {
    let tracker = windowManager.getWindowTracker(info.windowId);
    if (!tracker) {
      logger.debug(`Shuffle: window ${info.windowId} not found - triggering reconciliation`);

      try {
        await windowManager.reconcileWithBrowserState();
        tracker = windowManager.getWindowTracker(info.windowId);
      } catch (error) {
        logger.error(`Shuffle: Reconciliation failed`, error);
      }

      if (!tracker) {
        logger.warn(`Shuffle: window ${info.windowId} still not found after reconciliation`);
        return;
      }
    }

    const tabarr = tracker.tabarr;
    let tabInfo = findTabInMRU(tabarr, info.tabId);

    if (!tabInfo) {
      logger.debug(`Shuffle: tabId ${info.tabId} not found in MRU - triggering reconciliation`);

      try {
        await windowManager.reconcileWithBrowserState();
        tabInfo = findTabInMRU(tabarr, info.tabId);
      } catch (error) {
        logger.error(`Shuffle: Reconciliation failed`, error);
      }

      if (!tabInfo) {
        logger.warn(
          `Shuffle: tabId ${info.tabId} still not found after reconciliation`,
        );
        return;
      }
    }

    const mostRecentTabId = getMostRecentTabId(tabarr);
    if (mostRecentTabId === info.tabId) {
      logger.debug(`Shuffle: tabId ${info.tabId} already most recent`);
      return;
    }

    if (logger.isLoggingEnabled()) {
      // Only evaluate template strings when logging is enabled, to avoid
      // unnecessary .map() array allocations on every tab switch.
      logger.debug(`Shuffle: (before) [${tabarr.map((entry: any) => entry.tabId)}]`);
    }
    const updatedOrder = updateTabTimestamp(tabarr, info.tabId);
    if (updatedOrder !== null) {
      logger.debug(`Updated timestamp for tab ${info.tabId} to ${updatedOrder}`);
    }
    if (logger.isLoggingEnabled()) {
      logger.debug(`Shuffle: (after) [${tabarr.map((entry: any) => entry.tabId)}]`);
    }

    await storageManager.saveTrackingState(windowManager.getAllTrackers());
  });
}
