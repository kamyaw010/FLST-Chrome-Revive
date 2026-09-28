import { logger } from "../../utils/logger.js";
import { storageManager } from "../storage-manager.js";
import { settingsManager } from "../settings-manager.js";
import { SkipActivationReason } from "../../types.js";
import {
  addTabToMRU,
  getMostRecentTabId,
  removeTabFromMRU,
  updateTabTimestamp,
} from "./mru-utils.js";
import type { TabManagerRuntime } from "./runtime.js";

export async function handleTabReplacementEvent(
  _runtime: TabManagerRuntime,
  newId: number,
  oldId: number,
  windowManager: any,
): Promise<void> {
  const info = windowManager.findTab(oldId);
  if (info.tabarr && info.tabloc !== -1) {
    info.tabarr[info.tabloc].tabId = newId;
    logger.debug(`TabReplaced: ${oldId} -> ${newId}`);
    await storageManager.saveTrackingState(windowManager.getAllTrackers(), true);
  }
}

export async function handleTabAttachEvent(
  runtime: TabManagerRuntime,
  tabId: number,
  attachInfo: any,
  windowManager: any,
): Promise<void> {
  const tracker = windowManager.getWindowTracker(attachInfo.newWindowId);
  if (tracker) {
    addTabToMRU(tracker.tabarr, tabId, "last");
    runtime.skipNextActivation = { reason: SkipActivationReason.ATTACH };
    logger.debug(`TabAttached: ${tabId} to window ${attachInfo.newWindowId}`);
    await storageManager.saveTrackingState(windowManager.getAllTrackers(), true);
  }
}

export async function handleTabDetachEvent(
  runtime: TabManagerRuntime,
  tabId: number,
  detachInfo: any,
  windowManager: any,
): Promise<void> {
  const tracker = windowManager.getWindowTracker(detachInfo.oldWindowId);
  if (!tracker) return;

  removeTabFromMRU(tracker.tabarr, tabId);

  logger.debug(`Tracker: ${tracker.tabarr.length}`);
  if (tracker.tabarr.length > 0) {
    const lastTabId = getMostRecentTabId(tracker.tabarr);
    logger.debug(
      `TabDetached: ${tabId} from window ${detachInfo.oldWindowId}, last tab: ${lastTabId}`,
    );
    if (lastTabId) {
      runtime.setFocus(lastTabId, SkipActivationReason.DETACH);
    }
  }

  logger.debug(`TabDetached: ${tabId} from window ${detachInfo.oldWindowId}`);
  await storageManager.saveTrackingState(windowManager.getAllTrackers(), true);
}

export async function handleTabFlipEvent(
  runtime: TabManagerRuntime,
  tab: any,
  windowManager: any,
): Promise<void> {
  const settings = settingsManager.getSettings();
  if (!settings.flip || !tab.windowId) return;

  let tracker = windowManager.getWindowTracker(tab.windowId);
  if (!tracker) {
    logger.debug(`TabFlip: window ${tab.windowId} not found - triggering reconciliation`);

    try {
      await windowManager.reconcileWithBrowserState();
      tracker = windowManager.getWindowTracker(tab.windowId);
    } catch (error) {
      logger.error(`TabFlip: Reconciliation failed`, error);
    }

    if (!tracker) {
      logger.warn(`TabFlip: window ${tab.windowId} still not found after reconciliation`);
      return;
    }
  }

  if (tracker.tabarr.length < 2) {
    logger.debug(`TabFlip: Not enough tabs in window ${tab.windowId}`);
    return;
  }

  // O(n) two-pass: find the most-recent entry, then the second-most-recent,
  // instead of cloning the array and sorting O(n log n).
  let firstMax: { tabId: number; order: number } | null = null;
  let secondMax: { tabId: number; order: number } | null = null;
  for (const entry of tracker.tabarr) {
    if (!firstMax || entry.order > firstMax.order) {
      secondMax = firstMax;
      firstMax = entry;
    } else if (!secondMax || entry.order > secondMax.order) {
      secondMax = entry;
    }
  }
  if (firstMax && secondMax) {
    const previousTabId = secondMax.tabId;
    const updatedOrder = updateTabTimestamp(tracker.tabarr, previousTabId);
    if (updatedOrder !== null) {
      logger.debug(`Updated timestamp for tab ${previousTabId} to ${updatedOrder}`);
    }
    runtime.setFocus(previousTabId, SkipActivationReason.TAB_FLIP);
    logger.debug(`TabFlip: Switched to previous tab ${previousTabId}`);
  }
}
