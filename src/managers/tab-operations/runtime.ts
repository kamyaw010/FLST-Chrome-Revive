import type { SafeTabMoveCallback, SkipActivationInfo, SkipActivationReason } from "../../types.js";

export interface CloseOperationInfo {
  windowId: number;
  expectedTabId: number;
  timestamp: number;
}

export interface RecentSelectedNewTabInfo {
  tabId: number;
  timestamp: number;
}

export interface ManagedNewTabInfo {
  suppressRelocation: boolean;
  suppressActivation: boolean;
}

export interface TabManagerRuntime {
  skipNextActivation: SkipActivationInfo | null;
  lastCloseInfo: CloseOperationInfo | null;
  lastKnownActiveTabIds: Map<number, number>;
  recentSelectedNewTabs: Map<number, RecentSelectedNewTabInfo>;
  managedNewTabs: Map<number, ManagedNewTabInfo>;
  queueOperation(windowId: number, operation: () => Promise<void>): Promise<void>;
  safeTabMove(
    tabId: number,
    moveProperties: any,
    callback?: SafeTabMoveCallback,
    retryCount?: number,
  ): void;
  safeTabUpdate(tabId: number, updateProperties: any, retryCount?: number): void;
  setFocus(tabId: number, reason: SkipActivationReason): void;
}
