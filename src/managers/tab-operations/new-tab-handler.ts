import { logger } from "../../utils/logger.js";
import { storageManager } from "../storage-manager.js";
import { settingsManager } from "../settings-manager.js";
import { SkipActivationReason } from "../../types.js";
import { addTabToMRU, getLeastRecentOrder } from "./mru-utils.js";
import type { TabManagerRuntime } from "./runtime.js";

async function relocateAfterOpener(
  runtime: TabManagerRuntime,
  tabObj: any,
  logPrefix: string,
): Promise<void> {
  return new Promise((resolve) => {
    chrome.tabs.get(tabObj.openerTabId, (openerTab: any) => {
      if (chrome.runtime.lastError || !openerTab) {
        logger.debug(
          `${logPrefix}Opener tab ${tabObj.openerTabId} not found, falling back to standard`,
        );
        resolve();
        return;
      }

      const targetIndex = openerTab.index + 1;

      chrome.tabs.get(tabObj.id, (newTab: any) => {
        if (chrome.runtime.lastError || !newTab) {
          logger.debug(`${logPrefix}Tab ${tabObj.id} no longer exists`);
          resolve();
          return;
        }

        if (newTab.index !== targetIndex) {
          runtime.safeTabMove(tabObj.id, { index: targetIndex }, (_result, error) => {
            if (error) {
              logger.error(`${logPrefix}Move after opener failed: ${error}`);
            } else {
              logger.debug(
                `${logPrefix}Tab ${tabObj.id} moved to index ${targetIndex} (after opener ${tabObj.openerTabId})`,
              );
            }
            resolve();
          });
        } else {
          logger.debug(`${logPrefix}Tab ${tabObj.id} already at correct position`);
          resolve();
        }
      });
    });
  });
}

async function relocateTabToFarRight(
  runtime: TabManagerRuntime,
  tabObj: any,
  logPrefix: string,
  retryCount: number = 0,
): Promise<void> {
  return new Promise((resolve) => {
    chrome.tabs.get(tabObj.id, (tab: any) => {
      if (chrome.runtime.lastError || !tab) {
        logger.debug(`${logPrefix}Tab ${tabObj.id} no longer exists`);
        resolve();
        return;
      }

      chrome.tabs.query({ windowId: tabObj.windowId }, (tabs: any[]) => {
        if (chrome.runtime.lastError) {
          logger.error(`${logPrefix}Query error: ${chrome.runtime.lastError.message}`);
          resolve();
          return;
        }

        const tabIndex = tabs.findIndex((item) => item.id === tabObj.id);
        const targetIndex = tabs.length - 1;

        if (tabIndex === -1) {
          if (retryCount < 2) {
            logger.debug(
              `${logPrefix}Tab ${tabObj.id} not visible in query yet - retrying relocation (${retryCount + 1}/2)`,
            );
            setTimeout(() => {
              relocateTabToFarRight(runtime, tabObj, logPrefix, retryCount + 1).then(resolve);
            }, 50);
            return;
          }

          logger.warn(`${logPrefix}Tab ${tabObj.id} not found in query after relocation retries`);
          resolve();
          return;
        }

        if (tabIndex !== targetIndex) {
          runtime.safeTabMove(tabObj.id, { index: targetIndex }, (_result, error) => {
            if (error) {
              logger.error(`${logPrefix}Move failed after retries: ${error}`);
            } else {
              logger.debug(
                `${logPrefix}Tab ${tabObj.id} moved to far right index ${targetIndex} (was at index ${tabIndex})`,
              );
            }
            resolve();
          });
        } else {
          logger.debug(`${logPrefix}Tab ${tabObj.id} already at far right`);
          resolve();
        }
      });
    });
  });
}

export async function handleNewTabEvent(
  runtime: TabManagerRuntime,
  tabObj: any,
  windowManager: any,
): Promise<void> {
  const logPrefix = "NewTab: ";

  if (!tabObj.windowId) {
    logger.debug(`${logPrefix}Tab has no windowId`);
    return;
  }

  const settings = settingsManager.getSettings();
  const initialTracker = windowManager.getWindowTracker(tabObj.windowId);
  let relocatedBeforeQueue = false;
  const getManagedInfo = () => (tabObj.id ? runtime.managedNewTabs.get(tabObj.id) : undefined);

  // Track immediately so close-animation suppression works even if the tab is
  // closed before the queueOperation runs (race condition fix).
  if (tabObj.id && settings.ntsel) {
    runtime.recentSelectedNewTabs.set(tabObj.windowId, {
      tabId: tabObj.id,
      timestamp: Date.now(),
    });
  }

  if (tabObj.id && initialTracker?.moveok) {
    const initialExistingIndex = initialTracker.tabarr.findIndex(
      (entry: any) => entry.tabId === tabObj.id,
    );
    if (initialExistingIndex === -1 && !getManagedInfo()?.suppressRelocation) {
      if (settings.ntord && tabObj.openerTabId) {
        await relocateAfterOpener(runtime, tabObj, logPrefix);
        relocatedBeforeQueue = true;
      } else if (settings.reloc) {
        await relocateTabToFarRight(runtime, tabObj, logPrefix);
        relocatedBeforeQueue = true;
      }
    }
  }

  return runtime.queueOperation(tabObj.windowId, async () => {
    let tracker = initialTracker ?? windowManager.getWindowTracker(tabObj.windowId);
    if (!tracker) {
      logger.debug(
        `${logPrefix}Window ${tabObj.windowId} not found in tracking - triggering reconciliation`,
      );

      try {
        await windowManager.reconcileWithBrowserState();
        tracker = windowManager.getWindowTracker(tabObj.windowId);
      } catch (error) {
        logger.error(`${logPrefix}Reconciliation failed`, error);
      }

      if (!tracker) {
        logger.warn(`${logPrefix}Window ${tabObj.windowId} still not found after reconciliation`);
        return;
      }
    }

    logger.debug(
      `${logPrefix}windowId ${tabObj.windowId}, id ${tabObj.id}, reloc: ${settings.reloc}, ntsel: ${settings.ntsel}, ntord: ${settings.ntord}`,
    );

    const existingIndex = tabObj.id
      ? tracker.tabarr.findIndex((entry: any) => entry.tabId === tabObj.id)
      : -1;
    const managedInfo = getManagedInfo();

    // Relocate the new tab if settings require it, regardless of whether the
    // tab is already in the tracker.  During a service-worker restart race
    // condition, reconciliation can add the tab to the tracker *before* this
    // relocation code runs.  That used to cause relocation to be skipped
    // because existingIndex was !== -1.  The relocate functions themselves
    // handle the "already at correct position" case, so it's safe to always
    // attempt relocation when settings say so.
    if (
      tabObj.id &&
      tracker.moveok &&
      !relocatedBeforeQueue &&
      !managedInfo?.suppressRelocation
    ) {
      if (settings.ntord && tabObj.openerTabId) {
        await relocateAfterOpener(runtime, tabObj, logPrefix);
      } else if (settings.reloc) {
        await relocateTabToFarRight(runtime, tabObj, logPrefix);
      }
    }

    if (tabObj.id) {
      if (existingIndex === -1) {
        // Chrome does not include openerTabId in the onCreated event object, so
        // the reliable signal for a background/link open is `active === false`
        // (middle-click, Ctrl+click, target=_blank). Never steal focus for those;
        // only directly created tabs (Ctrl+T / new tab button, created active)
        // follow the ntsel setting.
        const isBackgroundCreated = tabObj.active === false;
        const isLinkOpened = Boolean(tabObj.openerTabId);

        if (settings.ntsel && !isBackgroundCreated && !isLinkOpened) {
          // recentSelectedNewTabs was already written at function entry (before
          // queueOperation) to avoid a race with fast close. No need to repeat.
          if (!managedInfo?.suppressActivation) {
            runtime.setFocus(tabObj.id, SkipActivationReason.NEW_TAB);
          }

          addTabToMRU(tracker.tabarr, tabObj.id, "last");
          logger.debug(`${logPrefix}[select new tab]`);
        } else {
          // Background tabs are not "recently used" until the user visits them.
          // Rank them below every existing entry so they never outrank the
          // active tab, which would break Alt+N flipping and close-selection.
          addTabToMRU(tracker.tabarr, tabObj.id, "first", getLeastRecentOrder(tracker.tabarr));
          logger.debug(
            `${logPrefix}[chrome standard - don't select${
              isBackgroundCreated || isLinkOpened ? " (background/link-opened)" : ""
            }]`,
          );
        }
      } else {
        logger.debug(`${logPrefix}Tab already exists in MRU at index ${existingIndex}`);
      }

      await storageManager.saveTrackingState(windowManager.getAllTrackers());

      if (managedInfo) {
        runtime.managedNewTabs.delete(tabObj.id);
      }
    }

    logger.debug(`${logPrefix}Tab processed successfully`);
  });
}
