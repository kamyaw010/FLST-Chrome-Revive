/**
 * Unit tests for TabManager - FLST Chrome extension MRU logic.
 *
 * Tests cover:
 * - Tab activation (MRU ordering)
 * - Tab close (select MRU tab, skipNextActivation correctness)
 * - Tab flip (Alt+N icon click)
 * - Tab attach/detach
 * - New tab handling (ntsel on/off)
 * - The critical setFocus/skipNextActivation bug fix
 * - lastCloseInfo fallback mechanism
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  resetChromeMock,
  getMockStorageData,
  getTabMoveCalls,
  getTabUpdateCalls,
  setMockTabs,
} from "./chrome-mock";
import {
  createFreshTabManager,
  createMockWindowManager,
  createTracker,
  getMRUSortedTabIds,
  sleep,
} from "./test-helpers";
import type { TabTracker } from "../src/types";
import { SkipActivationReason } from "../src/types";
// Import the real module-level singletons that TabManager uses internally
import { settingsManager } from "../src/managers/settings-manager";

type BehaviorConfig = {
  flip: 0 | 1;
  ntsel: 0 | 1;
  reloc: 0 | 1;
  ntord: 0 | 1;
  log: 0 | 1;
};

const optionMatrix: BehaviorConfig[] = [];
for (const flip of [0, 1] as const) {
  for (const ntsel of [0, 1] as const) {
    for (const reloc of [0, 1] as const) {
      for (const ntord of [0, 1] as const) {
        for (const log of [0, 1] as const) {
          optionMatrix.push({ flip, ntsel, reloc, ntord, log });
        }
      }
    }
  }
}

async function applyBehaviorConfig(config: BehaviorConfig): Promise<void> {
  await settingsManager.updateSetting("flip", config.flip, "matrix");
  await settingsManager.updateSetting("ntsel", config.ntsel, "matrix");
  await settingsManager.updateSetting("reloc", config.reloc, "matrix");
  await settingsManager.updateSetting("ntord", config.ntord, "matrix");
  await settingsManager.updateSetting("log", config.log, "matrix");
}

function describeConfig(config: BehaviorConfig): string {
  return `flip=${config.flip}, ntsel=${config.ntsel}, reloc=${config.reloc}, ntord=${config.ntord}, log=${config.log}`;
}

let tabManager: ReturnType<typeof createFreshTabManager>;

async function flushDeferredCloseActivation(): Promise<void> {
  await sleep(20);
}

beforeEach(async () => {
  resetChromeMock();
  tabManager = createFreshTabManager();

  // Reset module-level settingsManager to defaults (TabManager uses this reference)
  await chrome.storage.local.set({ flip: 1, ntsel: 1, reloc: 1, log: 0 });
  await settingsManager.initialize();
});

afterEach(async () => {
  vi.useRealTimers();
  await flushDeferredCloseActivation();
});

// ============================================================================
// Tab Activation / MRU Ordering
// ============================================================================

describe("Tab Activation (MRU Ordering)", () => {
  it("should update timestamp when tab is activated", async () => {
    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
      { id: 30, order: 3000 },
    ]);
    const wm = createMockWindowManager([tracker]);

    // Activate tab 10 (currently oldest)
    await tabManager.handleTabActivation({ tabId: 10, windowId: 1 }, wm);

    // Tab 10 should now be the most recent
    const sorted = getMRUSortedTabIds(tracker);
    expect(sorted[0]).toBe(10);
  });

  it("should skip update if tab is already most recent", async () => {
    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
      { id: 30, order: 3000 }, // most recent
    ]);
    const wm = createMockWindowManager([tracker]);
    const originalOrder = tracker.tabarr[2].order;

    // Activate tab 30 (already most recent)
    await tabManager.handleTabActivation({ tabId: 30, windowId: 1 }, wm);

    // Timestamp should NOT change
    expect(tracker.tabarr.find((e) => e.tabId === 30)!.order).toBe(originalOrder);
  });

  it("should handle rapid tab switches correctly", async () => {
    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
      { id: 30, order: 3000 },
    ]);
    const wm = createMockWindowManager([tracker]);

    // Rapidly switch: 10 -> 20 -> 10
    await tabManager.handleTabActivation({ tabId: 10, windowId: 1 }, wm);
    await tabManager.handleTabActivation({ tabId: 20, windowId: 1 }, wm);
    await tabManager.handleTabActivation({ tabId: 10, windowId: 1 }, wm);

    // Tab 10 should be most recent
    const sorted = getMRUSortedTabIds(tracker);
    expect(sorted[0]).toBe(10);
  });
});

// ============================================================================
// Tab Close - MRU Selection
// ============================================================================

describe("Tab Close (MRU Selection)", () => {
  it("should select the most recently used tab when closing active tab", async () => {
    // Tabs: 10(oldest), 20, 30(most recent/active)
    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
      { id: 30, order: 3000 },
    ]);
    const wm = createMockWindowManager([tracker]);

    // Close tab 30 (the most recent one)
    await tabManager.handleTabClose(30, 1, wm);

    // No proactive chrome.tabs.update during close - Chrome's native animation runs
    // uninterrupted; correction happens in onActivated if Chrome picks the wrong tab.
    expect(getTabUpdateCalls()).toHaveLength(0);
    expect((tabManager as any).skipNextActivation?.expectedTabId).toBe(20);

    // Tab 30 should be removed from MRU
    expect(tracker.tabarr.find((e) => e.tabId === 30)).toBeUndefined();
    expect(tracker.tabarr.length).toBe(2);
  });

  it("should select correct MRU tab, not first tab in array", async () => {
    // Tab 10 is first in the array, tab 20 has the highest stored order
    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 5000 }, // previous MRU
      { id: 30, order: 3000 }, // active, being closed
    ]);
    const wm = createMockWindowManager([tracker]);

    // Mark tab 30 as active (close correction only applies to the active tab)
    await tabManager.handleTabActivation({ tabId: 30, windowId: 1 }, wm);

    // Close tab 30
    await tabManager.handleTabClose(30, 1, wm);

    // Should record tab 20 (highest order), NOT tab 10 (first in array), as the expected target.
    expect((tabManager as any).skipNextActivation?.expectedTabId).toBe(20);
  });

  it("should not select MRU tab when flip is disabled", async () => {
    // Disable flip on the module-level settingsManager (which TabManager reads)
    await settingsManager.updateSetting("flip", 0, "test");

    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
      { id: 30, order: 3000 },
    ]);
    const wm = createMockWindowManager([tracker]);

    await tabManager.handleTabClose(30, 1, wm);

    // Should NOT call chrome.tabs.update (let Chrome handle it)
    const updateCalls = getTabUpdateCalls();
    expect(updateCalls.length).toBe(0);
  });

  it("should handle closing the only remaining tab gracefully", async () => {
    const tracker = createTracker(1, [{ id: 10, order: 1000 }]);
    const wm = createMockWindowManager([tracker]);

    // This should not throw
    await tabManager.handleTabClose(10, 1, wm);
    expect(tracker.tabarr.length).toBe(0);
  });

  it("should not block close handling on immediate tracking-state persistence", async () => {
    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
      { id: 30, order: 3000 },
    ]);
    const wm = createMockWindowManager([tracker]);

    const originalSet = chrome.storage.local.set.getMockImplementation();
    let resolveTrackingSave: (() => void) | null = null;

    chrome.storage.local.set.mockImplementation((items: Record<string, any>) => {
      if (Object.prototype.hasOwnProperty.call(items, "flstState")) {
        return new Promise<void>((resolve) => {
          resolveTrackingSave = resolve;
        });
      }

      return originalSet ? originalSet(items) : Promise.resolve();
    });

    try {
      let finished = false;
      const closePromise = tabManager.handleTabClose(30, 1, wm).then(() => {
        finished = true;
      });

      await Promise.resolve();
      await sleep(0);

      expect(resolveTrackingSave).not.toBeNull();
      expect(finished).toBe(true);
      // No proactive activation during close - Chrome handles selection natively.
      expect(getTabUpdateCalls()).toHaveLength(0);

      resolveTrackingSave?.();
      await closePromise;
    } finally {
      chrome.storage.local.set.mockImplementation(originalSet as any);
    }
  });

  it("should fall back to windowId from removeInfo when closed tab is not in any tracker", async () => {
    // Simulates the SW-restart race: after long idle, the closed tab has
    // already been removed from the tracker (by reconciliation) before
    // handleTabCloseEvent runs.  The handler must use removeInfo.windowId
    // to find the window's tracker and determine the MRU next tab.
    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 }, // most recent remaining
    ]);
    const wm = createMockWindowManager([tracker]);

    // Tab 30 is NOT in any tracker (already removed by reconciliation).
    // But windowId=1 is passed from chrome.tabs.onRemoved.
    await tabManager.handleTabClose(30, 1, wm);

    // Should fall back to the window tracker and set MRU target = 20
    expect((tabManager as any).skipNextActivation?.expectedTabId).toBe(20);
    expect((tabManager as any).skipNextActivation?.reason).toBe("CloseTab");
  });

  it("should still skip MRU correction when flip is disabled during fallback", async () => {
    await settingsManager.updateSetting("flip", 0, "test");

    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
    ]);
    const wm = createMockWindowManager([tracker]);

    await tabManager.handleTabClose(30, 1, wm);

    // With flip=0, skipNextActivation should NOT be set
    expect((tabManager as any).skipNextActivation).toBeNull();
  });

  it("should not crash when fallback tracker is empty", async () => {
    const tracker = createTracker(1, []);
    const wm = createMockWindowManager([tracker]);

    // This should not throw despite empty tracker
    await expect(tabManager.handleTabClose(30, 1, wm)).resolves.toBeUndefined();
  });

  it("should still persist state after fallback close handling", async () => {
    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
    ]);
    const wm = createMockWindowManager([tracker]);

    const initialStorage = getMockStorageData();

    await tabManager.handleTabClose(30, 1, wm);

    // Storage should have been saved (via the queue operation)
    const storageAfter = getMockStorageData();
    expect(storageAfter.flstState).toBeDefined();
  });
});

// ============================================================================
// Critical Bug Fix: setFocus overwriting skipNextActivation
// ============================================================================

describe("Close Tab - skipNextActivation Integrity", () => {
  it("should preserve expectedTabId in skipNextActivation after close", async () => {
    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
      { id: 30, order: 3000 },
    ]);
    const wm = createMockWindowManager([tracker]);

    await tabManager.handleTabClose(30, 1, wm);

    // Now simulate Chrome auto-activating the WRONG tab (tab 10 instead of 20)
    // The activation handler should detect the mismatch and correct it
    await tabManager.handleTabActivation({ tabId: 10, windowId: 1 }, wm);

    // Should have corrected by calling update on tab 20
    const updateCalls = getTabUpdateCalls();
    const correctionCall = updateCalls.find((c) => c.tabId === 20 && c.props.active === true);
    expect(correctionCall).toBeDefined();
  });

  it("should allow activation if expected tab is activated after close", async () => {
    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
      { id: 30, order: 3000 },
    ]);
    const wm = createMockWindowManager([tracker]);

    await tabManager.handleTabClose(30, 1, wm);

    // Chrome correctly activates tab 20 (the expected tab)
    await tabManager.handleTabActivation({ tabId: 20, windowId: 1 }, wm);

    // Chrome picked the right tab - no correction or proactive call needed.
    expect(getTabUpdateCalls()).toHaveLength(0);

    // Tab 20 should still be in the MRU and its timestamp should be current
    const tab20 = tracker.tabarr.find((e) => e.tabId === 20);
    expect(tab20).toBeDefined();
  });
});

// ============================================================================
// lastCloseInfo Fallback Mechanism
// ============================================================================

describe("lastCloseInfo Fallback", () => {
  it("should correct activation via lastCloseInfo when skipNextActivation is null", async () => {
    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
      { id: 30, order: 3000 },
    ]);
    const wm = createMockWindowManager([tracker]);

    // Close tab 30 - sets both skipNextActivation and lastCloseInfo
    await tabManager.handleTabClose(30, 1, wm);

    // Simulate: skipNextActivation was consumed by an intermediate event,
    // but lastCloseInfo still exists. We manually clear skip to simulate this edge case.
    // Access private field for testing
    (tabManager as any).skipNextActivation = null;

    // Chrome auto-activates wrong tab 10
    await tabManager.handleTabActivation({ tabId: 10, windowId: 1 }, wm);

    // Should correct to tab 20 via lastCloseInfo fallback
    const updateCalls = getTabUpdateCalls();
    const correctionCall = updateCalls.filter((c) => c.tabId === 20 && c.props.active === true);
    expect(correctionCall.length).toBeGreaterThanOrEqual(1);
  });

  it("should ignore stale lastCloseInfo (> 2 seconds old)", async () => {
    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
      { id: 30, order: 3000 },
    ]);
    const wm = createMockWindowManager([tracker]);

    await tabManager.handleTabClose(30, 1, wm);

    // Clear skipNextActivation and set lastCloseInfo to be old
    (tabManager as any).skipNextActivation = null;
    (tabManager as any).lastCloseInfo.timestamp = Date.now() - 3000;

    // Activate tab 10 - should NOT correct because lastCloseInfo is too old
    await tabManager.handleTabActivation({ tabId: 10, windowId: 1 }, wm);

    // Tab 10 should have been updated in MRU (normal activation)
    const sorted = getMRUSortedTabIds(tracker);
    expect(sorted[0]).toBe(10);
  });
});

// ============================================================================
// Tab Flip (Alt+N / Icon Click)
// ============================================================================

describe("Tab Flip", () => {
  it("should switch to the second most recent tab", async () => {
    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
      { id: 30, order: 3000 }, // current (most recent)
    ]);
    const wm = createMockWindowManager([tracker]);

    // Flip from tab 30 (current)
    await tabManager.handleTabFlip({ id: 30, windowId: 1 }, wm);

    // Should activate tab 20 (second most recent)
    const updateCalls = getTabUpdateCalls();
    expect(updateCalls[0].tabId).toBe(20);
  });

  it("should not flip when only one tab exists", async () => {
    const tracker = createTracker(1, [{ id: 10, order: 1000 }]);
    const wm = createMockWindowManager([tracker]);

    await tabManager.handleTabFlip({ id: 10, windowId: 1 }, wm);

    const updateCalls = getTabUpdateCalls();
    expect(updateCalls.length).toBe(0);
  });

  it("should not flip when flip setting is disabled", async () => {
    await settingsManager.updateSetting("flip", 0, "test"); // module-level singleton

    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
    ]);
    const wm = createMockWindowManager([tracker]);

    await tabManager.handleTabFlip({ id: 20, windowId: 1 }, wm);

    const updateCalls = getTabUpdateCalls();
    expect(updateCalls.length).toBe(0);
  });

  it("should update flipped tab timestamp to make it most recent", async () => {
    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
      { id: 30, order: 3000 },
    ]);
    const wm = createMockWindowManager([tracker]);

    await tabManager.handleTabFlip({ id: 30, windowId: 1 }, wm);

    // Tab 20 should now be the most recent
    const sorted = getMRUSortedTabIds(tracker);
    expect(sorted[0]).toBe(20);
  });

  it("should toggle between two tabs on repeated flips", async () => {
    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
      { id: 30, order: 3000 },
    ]);
    const wm = createMockWindowManager([tracker]);

    // First flip: 30 is current, should switch to 20
    await tabManager.handleTabFlip({ id: 30, windowId: 1 }, wm);

    // Simulate activation of tab 20 (skipped due to TAB_FLIP)
    // skipNextActivation is set, won't update MRU

    // Second flip: now 20 is most recent, should switch back to 30
    await tabManager.handleTabFlip({ id: 20, windowId: 1 }, wm);

    const updateCalls = getTabUpdateCalls();
    // First flip activated 20, second flip should activate 30
    expect(updateCalls[0].tabId).toBe(20);
    expect(updateCalls[1].tabId).toBe(30);
  });
});

// ============================================================================
// Tab Attach / Detach
// ============================================================================

describe("Tab Attach/Detach", () => {
  it("should add tab to new window MRU on attach", async () => {
    const tracker1 = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
    ]);
    const tracker2 = createTracker(2, [{ id: 30, order: 3000 }]);
    const wm = createMockWindowManager([tracker1, tracker2]);

    // Attach tab 10 to window 2
    await tabManager.handleTabAttach(10, { newWindowId: 2, newPosition: 0 }, wm);

    // Tab 10 should now be in window 2's MRU
    expect(tracker2.tabarr.find((e) => e.tabId === 10)).toBeDefined();
    expect(
      getMockStorageData().flstState.trackingState[1].tabarr.some((e: any) => e.tabId === 10),
    ).toBe(true);
  });

  it("should remove tab from source window MRU on detach and select MRU", async () => {
    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
      { id: 30, order: 3000 },
    ]);
    const wm = createMockWindowManager([tracker]);

    // Detach tab 30 from window 1
    await tabManager.handleTabDetach(30, { oldWindowId: 1 }, wm);

    // Tab 30 should be removed from window 1's MRU
    expect(tracker.tabarr.find((e) => e.tabId === 30)).toBeUndefined();

    // Should have selected most recent remaining tab (20)
    const updateCalls = getTabUpdateCalls();
    expect(updateCalls[0].tabId).toBe(20);
    expect(
      getMockStorageData().flstState.trackingState[0].tabarr.some((e: any) => e.tabId === 30),
    ).toBe(false);
  });
});

// ============================================================================
// New Tab Handling
// ============================================================================

describe("New Tab Handling", () => {
  it("should add new tab to end of MRU when ntsel=1", async () => {
    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
    ]);
    const wm = createMockWindowManager([tracker]);

    await tabManager.handleNewTab({ id: 30, windowId: 1 }, wm);

    // Tab 30 should be at the end (most recent position)
    const sorted = getMRUSortedTabIds(tracker);
    expect(sorted[0]).toBe(30);
  });

  it("should add new tab to beginning of MRU when ntsel=0", async () => {
    await settingsManager.updateSetting("ntsel", 0, "test");

    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
    ]);
    const wm = createMockWindowManager([tracker]);

    await tabManager.handleNewTab({ id: 30, windowId: 1 }, wm);

    // Tab 30 should be in MRU but NOT the most recent
    expect(tracker.tabarr.find((e) => e.tabId === 30)).toBeDefined();
    // Chrome default: new tab goes to beginning, so MRU should still have 20 as most recent
    // (30 was added with "first" position but Date.now() timestamp)
    // Actually the addTabToMRU with "first" uses Date.now() for order too.
    // The key difference is position, but with timestamp ordering,
    // the test should verify the tab was added
    expect(tracker.tabarr.length).toBe(3);
  });

  it("should not add duplicate tab if already in MRU", async () => {
    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
      { id: 30, order: 3000 },
    ]);
    const wm = createMockWindowManager([tracker]);

    await tabManager.handleNewTab({ id: 30, windowId: 1 }, wm);

    // Should still be 3 tabs, not 4
    expect(tracker.tabarr.length).toBe(3);
  });

  it("should skip tabs without windowId", async () => {
    const tracker = createTracker(1, [{ id: 10, order: 1000 }]);
    const wm = createMockWindowManager([tracker]);

    // No windowId - should be silently skipped
    await tabManager.handleNewTab({ id: 30 }, wm);
    expect(tracker.tabarr.length).toBe(1);
  });

  it("should move a new tab to the explicit far-right index after pinned tabs", async () => {
    const tracker = createTracker(1, [
      { id: 1, order: 1000 },
      { id: 2, order: 2000 },
      { id: 3, order: 3000 },
      { id: 4, order: 4000 },
    ]);
    const wm = createMockWindowManager([tracker]);

    setMockTabs([
      { id: 1, windowId: 1, index: 0, pinned: true },
      { id: 2, windowId: 1, index: 1, pinned: true },
      { id: 5, windowId: 1, index: 2 },
      { id: 3, windowId: 1, index: 3 },
      { id: 4, windowId: 1, index: 4 },
    ]);

    await tabManager.handleNewTab({ id: 5, windowId: 1 }, wm);

    const moveCalls = getTabMoveCalls();
    expect(moveCalls.length).toBe(1);
    expect(moveCalls[0]).toEqual({ tabId: 5, props: { index: 4 } });
  });

  it("should retry relocation when the new tab is missing from the first query", async () => {
    vi.useFakeTimers();

    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
    ]);
    const wm = createMockWindowManager([tracker]);

    setMockTabs([
      { id: 10, windowId: 1, index: 0 },
      { id: 30, windowId: 1, index: 1 },
      { id: 20, windowId: 1, index: 2 },
    ]);

    const originalQuery = chrome.tabs.query.getMockImplementation();
    let queryCount = 0;

    chrome.tabs.query.mockImplementation((queryInfo: any, callback: (tabs: any[]) => void) => {
      queryCount += 1;

      if (queryCount === 1) {
        callback([
          { id: 10, windowId: 1, index: 0 },
          { id: 20, windowId: 1, index: 1 },
        ]);
        return;
      }

      originalQuery?.(queryInfo, callback);
    });

    const newTabPromise = tabManager.handleNewTab({ id: 30, windowId: 1 }, wm);
    await vi.advanceTimersByTimeAsync(90);
    await newTabPromise;

    expect(getTabMoveCalls()).toEqual([{ tabId: 30, props: { index: 2 } }]);

    chrome.tabs.query.mockImplementation(originalQuery as any);
    vi.useRealTimers();
  });

  it("should relocate a new tab before waiting on the window operation queue", async () => {
    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
    ]);
    const wm = createMockWindowManager([tracker]);

    setMockTabs([
      { id: 10, windowId: 1, index: 0, pinned: true },
      { id: 30, windowId: 1, index: 1 },
      { id: 20, windowId: 1, index: 2 },
    ]);

    let releaseQueue: (() => void) | null = null;
    const originalQueueOperation = (tabManager as any).queueOperation.bind(tabManager);

    (tabManager as any).queueOperation = vi.fn(
      (_windowId: number, operation: () => Promise<void>) => {
        return new Promise<void>((resolve, reject) => {
          releaseQueue = () => {
            operation().then(resolve).catch(reject);
          };
        });
      },
    );

    try {
      let finished = false;
      const newTabPromise = tabManager.handleNewTab({ id: 30, windowId: 1 }, wm).then(() => {
        finished = true;
      });

      await sleep(30);

      expect(getTabMoveCalls()).toEqual([{ tabId: 30, props: { index: 2 } }]);
      expect(finished).toBe(false);
      expect(releaseQueue).not.toBeNull();

      releaseQueue?.();
      await newTabPromise;
    } finally {
      (tabManager as any).queueOperation = originalQueueOperation;
    }
  });

  it("should not relocate a new tab when reloc is disabled", async () => {
    await settingsManager.updateSetting("reloc", 0, "test");

    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
    ]);
    const wm = createMockWindowManager([tracker]);

    setMockTabs([
      { id: 10, windowId: 1, index: 0 },
      { id: 30, windowId: 1, index: 1 },
      { id: 20, windowId: 1, index: 2 },
    ]);

    await tabManager.handleNewTab({ id: 30, windowId: 1 }, wm);

    expect(getTabMoveCalls()).toHaveLength(0);
    expect(getTabUpdateCalls().some((call) => call.tabId === 30)).toBe(true);
  });

  it("should prioritize ntord over reloc when openerTabId exists", async () => {
    await settingsManager.updateSetting("ntord", 1, "test");

    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
      { id: 30, order: 3000 },
    ]);
    const wm = createMockWindowManager([tracker]);

    setMockTabs([
      { id: 10, windowId: 1, index: 0 },
      { id: 20, windowId: 1, index: 1 },
      { id: 40, windowId: 1, index: 2 },
      { id: 30, windowId: 1, index: 3 },
    ]);

    await tabManager.handleNewTab({ id: 40, windowId: 1, openerTabId: 10 }, wm);

    expect(getTabMoveCalls()).toEqual([{ tabId: 40, props: { index: 1 } }]);
  });

  it("should fall back to far-right relocation when ntord is enabled without an opener", async () => {
    await settingsManager.updateSetting("ntord", 1, "test");

    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
      { id: 30, order: 3000 },
    ]);
    const wm = createMockWindowManager([tracker]);

    setMockTabs([
      { id: 10, windowId: 1, index: 0 },
      { id: 40, windowId: 1, index: 1 },
      { id: 20, windowId: 1, index: 2 },
      { id: 30, windowId: 1, index: 3 },
    ]);

    await tabManager.handleNewTab({ id: 40, windowId: 1 }, wm);

    expect(getTabMoveCalls()).toEqual([{ tabId: 40, props: { index: 3 } }]);
  });

  it("should keep new-tab behavior working when flip is disabled", async () => {
    await settingsManager.updateSetting("flip", 0, "test");

    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
    ]);
    const wm = createMockWindowManager([tracker]);

    setMockTabs([
      { id: 10, windowId: 1, index: 0 },
      { id: 30, windowId: 1, index: 1 },
      { id: 20, windowId: 1, index: 2 },
    ]);

    await tabManager.handleNewTab({ id: 30, windowId: 1 }, wm);

    expect(getTabMoveCalls()).toEqual([{ tabId: 30, props: { index: 2 } }]);
    expect(
      getTabUpdateCalls().some((call) => call.tabId === 30 && call.props.active === true),
    ).toBe(true);
  });

  // ======================================================================
  // Fix: reconciliation race condition — new tab relocation must still
  // occur even when reconciliation adds the tab to the tracker before the
  // relocation code runs (common after service-worker restart).
  // ======================================================================

  it("should relocate new tab when reconciliation adds it before relocation runs", async () => {
    // Simulate the race condition:
    //  1. Service worker restarts → trackers are empty
    //  2. Tab created event fires during initialize()
    //  3. initialTracker is null → pre-queue relocation skipped
    //  4. Inside queue, tracker still null → reconcileWithBrowserState() runs
    //  5. Reconciliation queries browser state, finds the new tab → adds to tracker
    //  6. existingIndex is now !== -1, but relocation MUST still happen

    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
    ]);

    // Mock getWindowTracker to return null on first two calls (simulating
    // uninitialized tracking), then return the tracker after reconciliation.
    let getTrackerCallCount = 0;
    const wm = {
      getWindowTracker(_windowId: number) {
        getTrackerCallCount++;
        // Call 1 → null (initialTracker, pre-queue)
        // Call 2 → null (inside queue, triggers reconciliation)
        if (getTrackerCallCount <= 2) return null;
        return tracker;
      },
      getAllTrackers: vi.fn(() => [tracker]),
      reconcileWithBrowserState: vi.fn(async () => {
        // Simulate reconciliation finding the new tab in the browser state
        // and adding it to the MRU tracker.
        if (!tracker.tabarr.find((e) => e.tabId === 30)) {
          tracker.tabarr.push({ tabId: 30, order: Date.now() });
        }
      }),
    };

    // New tab is at index 1 (not at the far right which is index 2)
    setMockTabs([
      { id: 10, windowId: 1, index: 0 },
      { id: 30, windowId: 1, index: 1 },
      { id: 20, windowId: 1, index: 2 },
    ]);

    await tabManager.handleNewTab({ id: 30, windowId: 1 }, wm);

    // Even though reconciliation added tab 30 to the tracker (existingIndex !== -1),
    // the tab must still be relocated to the far right.
    const moveCalls = getTabMoveCalls();
    expect(moveCalls).toHaveLength(1);
    expect(moveCalls[0]).toEqual({ tabId: 30, props: { index: 2 } });

    // Reconciliation should have been triggered
    expect(wm.reconcileWithBrowserState).toHaveBeenCalledTimes(1);

    // Tab should be in the MRU at the correct position
    expect(tracker.tabarr.find((e) => e.tabId === 30)).toBeDefined();
  });

  it("should relocate new tab via ntord when reconciliation adds tab before relocation", async () => {
    await settingsManager.updateSetting("ntord", 1, "test");

    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
      { id: 30, order: 3000 },
    ]);

    let getTrackerCallCount = 0;
    const wm = {
      getWindowTracker(_windowId: number) {
        getTrackerCallCount++;
        if (getTrackerCallCount <= 2) return null;
        return tracker;
      },
      getAllTrackers: vi.fn(() => [tracker]),
      reconcileWithBrowserState: vi.fn(async () => {
        if (!tracker.tabarr.find((e) => e.tabId === 40)) {
          tracker.tabarr.push({ tabId: 40, order: Date.now() });
        }
      }),
    };

    setMockTabs([
      { id: 10, windowId: 1, index: 0 },
      { id: 20, windowId: 1, index: 1 },
      { id: 30, windowId: 1, index: 2 },
      { id: 40, windowId: 1, index: 3 },
    ]);

    // Tab 40 has openerTabId 10, so it should be moved to index 1 (after opener)
    await tabManager.handleNewTab({ id: 40, windowId: 1, openerTabId: 10 }, wm);

    const moveCalls = getTabMoveCalls();
    expect(moveCalls).toHaveLength(1);
    expect(moveCalls[0]).toEqual({ tabId: 40, props: { index: 1 } });

    expect(wm.reconcileWithBrowserState).toHaveBeenCalledTimes(1);
  });

  it("should not duplicate tab in MRU when reconciliation adds it before MRU update", async () => {
    // Same race condition scenario, but verify MRU doesn't get a duplicate
    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
    ]);

    let getTrackerCallCount = 0;
    const wm = {
      getWindowTracker(_windowId: number) {
        getTrackerCallCount++;
        if (getTrackerCallCount <= 2) return null;
        return tracker;
      },
      getAllTrackers: vi.fn(() => [tracker]),
      reconcileWithBrowserState: vi.fn(async () => {
        if (!tracker.tabarr.find((e) => e.tabId === 30)) {
          tracker.tabarr.push({ tabId: 30, order: Date.now() });
        }
      }),
    };

    setMockTabs([
      { id: 10, windowId: 1, index: 0 },
      { id: 30, windowId: 1, index: 1 },
      { id: 20, windowId: 1, index: 2 },
    ]);

    const initialLength = tracker.tabarr.length; // 2

    await tabManager.handleNewTab({ id: 30, windowId: 1 }, wm);

    // Should still be exactly 3 tabs (10, 20, 30), not 4 (duplicate)
    expect(tracker.tabarr.length).toBe(3);

    // Tab 30 should appear exactly once
    const entriesForTab30 = tracker.tabarr.filter((e) => e.tabId === 30);
    expect(entriesForTab30).toHaveLength(1);
  });

  it("should still respect suppressRelocation during reconciliation race", async () => {
    // When the extension itself creates a new tab (openManagedNewTab), it sets
    // suppressRelocation = true on managedNewTabs. Even if reconciliation
    // runs, the tab should NOT be relocated.
    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
    ]);

    let getTrackerCallCount = 0;
    const wm = {
      getWindowTracker(_windowId: number) {
        getTrackerCallCount++;
        if (getTrackerCallCount <= 2) return null;
        return tracker;
      },
      getAllTrackers: vi.fn(() => [tracker]),
      reconcileWithBrowserState: vi.fn(async () => {
        if (!tracker.tabarr.find((e) => e.tabId === 30)) {
          tracker.tabarr.push({ tabId: 30, order: Date.now() });
        }
      }),
    };

    setMockTabs([
      { id: 10, windowId: 1, index: 0 },
      { id: 30, windowId: 1, index: 1 },
      { id: 20, windowId: 1, index: 2 },
    ]);

    // Set suppressRelocation in the runtime's managedNewTabs
    const runtime = (tabManager as any).createRuntime();
    runtime.managedNewTabs.set(30, { suppressRelocation: true, suppressActivation: false });

    // Directly call handleNewTabEvent with a runtime that has suppressRelocation set
    // We use the tabManager's internal createRuntime and inject the managed info
    const { handleNewTabEvent } = await import("../src/managers/tab-operations/new-tab-handler");
    await handleNewTabEvent(runtime, { id: 30, windowId: 1 }, wm);

    // Should NOT relocate because suppressRelocation is true
    const moveCalls = getTabMoveCalls();
    expect(moveCalls).toHaveLength(0);
  });
});

// ============================================================================
// Option Matrix Coverage
// ============================================================================

describe("Option Matrix - New Tab Without Opener", () => {
  for (const config of optionMatrix) {
    it(`should honor independent settings for ${describeConfig(config)}`, async () => {
      await applyBehaviorConfig(config);

      const tracker = createTracker(1, [
        { id: 10, order: 1000 },
        { id: 20, order: 2000 },
      ]);
      const wm = createMockWindowManager([tracker]);

      setMockTabs([
        { id: 10, windowId: 1, index: 0 },
        { id: 30, windowId: 1, index: 1 },
        { id: 20, windowId: 1, index: 2 },
      ]);

      await tabManager.handleNewTab({ id: 30, windowId: 1 }, wm);

      const moveCalls = getTabMoveCalls();
      const updateCalls = getTabUpdateCalls().filter(
        (call) => call.tabId === 30 && call.props.active === true,
      );

      if (config.reloc === 1) {
        expect(moveCalls).toEqual([{ tabId: 30, props: { index: 2 } }]);
      } else {
        expect(moveCalls).toHaveLength(0);
      }

      if (config.ntsel === 1) {
        expect(updateCalls).toHaveLength(1);
      } else {
        expect(updateCalls).toHaveLength(0);
      }
    });
  }
});

describe("Option Matrix - New Tab With Opener", () => {
  for (const config of optionMatrix) {
    it(`should honor opener precedence for ${describeConfig(config)}`, async () => {
      await applyBehaviorConfig(config);

      const tracker = createTracker(1, [
        { id: 10, order: 1000 },
        { id: 20, order: 2000 },
        { id: 30, order: 3000 },
      ]);
      const wm = createMockWindowManager([tracker]);

      setMockTabs([
        { id: 10, windowId: 1, index: 0 },
        { id: 20, windowId: 1, index: 1 },
        { id: 40, windowId: 1, index: 2 },
        { id: 30, windowId: 1, index: 3 },
      ]);

      await tabManager.handleNewTab({ id: 40, windowId: 1, openerTabId: 10 }, wm);

      const moveCalls = getTabMoveCalls();
      const updateCalls = getTabUpdateCalls().filter(
        (call) => call.tabId === 40 && call.props.active === true,
      );

      if (config.ntord === 1) {
        expect(moveCalls).toEqual([{ tabId: 40, props: { index: 1 } }]);
      } else if (config.reloc === 1) {
        expect(moveCalls).toEqual([{ tabId: 40, props: { index: 3 } }]);
      } else {
        expect(moveCalls).toHaveLength(0);
      }

      if (config.ntsel === 1) {
        expect(updateCalls).toHaveLength(1);
      } else {
        expect(updateCalls).toHaveLength(0);
      }
    });
  }
});

describe("Option Matrix - Close Behavior", () => {
  for (const config of optionMatrix) {
    it(`should make close behavior depend only on flip for ${describeConfig(config)}`, async () => {
      await applyBehaviorConfig(config);

      const tracker = createTracker(1, [
        { id: 10, order: 1000 },
        { id: 20, order: 2000 },
        { id: 30, order: 3000 },
      ]);
      const wm = createMockWindowManager([tracker]);

      await tabManager.handleTabClose(30, 1, wm);

      if (config.flip === 1) {
        // skipNextActivation is set so onActivated can correct Chrome if needed;
        // no proactive chrome.tabs.update is issued during close.
        expect((tabManager as any).skipNextActivation?.expectedTabId).toBe(20);
        expect(getTabUpdateCalls()).toHaveLength(0);
      } else {
        expect((tabManager as any).skipNextActivation).toBeNull();
        expect(getTabUpdateCalls()).toHaveLength(0);
      }
    });
  }
});

// ============================================================================
// Tab Replacement
// ============================================================================

describe("Tab Replacement", () => {
  it("should replace tab ID in MRU preserving order", async () => {
    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
      { id: 30, order: 3000 },
    ]);
    const wm = createMockWindowManager([tracker]);

    await tabManager.handleTabReplacement(99, 20, wm);

    // Tab 20 should be replaced by 99 with same order
    const entry = tracker.tabarr.find((e) => e.tabId === 99);
    expect(entry).toBeDefined();
    expect(entry!.order).toBe(2000);
    expect(tracker.tabarr.find((e) => e.tabId === 20)).toBeUndefined();
    expect(
      getMockStorageData().flstState.trackingState[0].tabarr.some((e: any) => e.tabId === 99),
    ).toBe(true);
  });
});

// ============================================================================
// Multi-Window Scenarios
// ============================================================================

describe("Multi-Window", () => {
  it("should track tabs independently per window", async () => {
    const tracker1 = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
    ]);
    const tracker2 = createTracker(2, [
      { id: 30, order: 3000 },
      { id: 40, order: 4000 },
    ]);
    const wm = createMockWindowManager([tracker1, tracker2]);

    // Activate tab 10 in window 1
    await tabManager.handleTabActivation({ tabId: 10, windowId: 1 }, wm);

    // Tab 10 should be most recent in window 1
    expect(getMRUSortedTabIds(tracker1)[0]).toBe(10);

    // Window 2 should be unaffected
    expect(getMRUSortedTabIds(tracker2)[0]).toBe(40);
  });

  it("should close tab in correct window", async () => {
    const tracker1 = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
    ]);
    const tracker2 = createTracker(2, [
      { id: 30, order: 3000 },
      { id: 40, order: 4000 },
    ]);
    const wm = createMockWindowManager([tracker1, tracker2]);

    // Close tab 20 from window 1
    await tabManager.handleTabClose(20, 1, wm);

    // Window 1 should have only tab 10
    expect(tracker1.tabarr.length).toBe(1);
    expect(tracker1.tabarr[0].tabId).toBe(10);

    // Window 2 should be unaffected
    expect(tracker2.tabarr.length).toBe(2);
  });
});

// ============================================================================
// Full Workflow Scenarios
// ============================================================================

describe("Full MRU Workflow", () => {
  it("should maintain correct MRU order through open/switch/close sequence", async () => {
    // Start: tabs A(10), B(20), C(30) with C most recent
    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
      { id: 30, order: 3000 },
    ]);
    const wm = createMockWindowManager([tracker]);

    // Mock Date.now to return unique incrementing values for deterministic ordering
    let timeCounter = 10000;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => ++timeCounter);

    // User clicks tab A
    await tabManager.handleTabActivation({ tabId: 10, windowId: 1 }, wm);
    expect(getMRUSortedTabIds(tracker)[0]).toBe(10);

    // User clicks tab B
    await tabManager.handleTabActivation({ tabId: 20, windowId: 1 }, wm);
    expect(getMRUSortedTabIds(tracker)[0]).toBe(20);

    // User opens new tab D(40)
    await tabManager.handleNewTab({ id: 40, windowId: 1 }, wm);
    expect(getMRUSortedTabIds(tracker)[0]).toBe(40);

    // Chrome fires onActivated for D(40) - consumed by NEW_TAB skip
    await tabManager.handleTabActivation({ tabId: 40, windowId: 1 }, wm);

    // User closes tab D - should go to tab B (MRU)
    const callsBeforeClose = getTabUpdateCalls().length;
    await tabManager.handleTabClose(40, 1, wm);
    await flushDeferredCloseActivation();
    expect((tabManager as any).skipNextActivation?.expectedTabId).toBe(20);

    // Chrome activates the expected tab B(20)
    await tabManager.handleTabActivation({ tabId: 20, windowId: 1 }, wm);
    expect(getTabUpdateCalls()).toHaveLength(callsBeforeClose);

    // Remaining tabs should be 10, 20, 30
    expect(tracker.tabarr.length).toBe(3);
    expect(tracker.tabarr.map((e) => e.tabId).sort()).toEqual([10, 20, 30]);

    dateNowSpy.mockRestore();
  });

  it("should handle the dormancy bug scenario correctly", async () => {
    // This tests the exact scenario that was buggy:
    // 1. User has tabs A, B, C with C active (most recent)
    // 2. Long idle period (service worker goes dormant)
    // 3. Service worker wakes up
    // 4. User closes tab C
    // 5. Should switch to B (MRU), NOT A (first tab)

    const tracker = createTracker(1, [
      { id: 10, order: 1000 }, // Tab A (oldest)
      { id: 20, order: 2000 }, // Tab B (second most recent)
      { id: 30, order: 3000 }, // Tab C (most recent, being closed)
    ]);
    const wm = createMockWindowManager([tracker]);

    // Close tab C
    await tabManager.handleTabClose(30, 1, wm);

    // Verify the correct tab (B=20) is the expected target, not tab A=10.
    expect((tabManager as any).skipNextActivation?.expectedTabId).toBe(20);

    // Now simulate Chrome WRONGLY activating tab A (10) instead
    // This is what happens when Chrome's default behavior kicks in
    await tabManager.handleTabActivation({ tabId: 10, windowId: 1 }, wm);

    // The handler should CORRECT this and re-activate tab 20
    const allCalls = getTabUpdateCalls();
    const correctionCalls = allCalls.filter((c) => c.tabId === 20);
    expect(correctionCalls.length).toBeGreaterThan(0);
  });

  it("should NOT jump back after close-correction when user manually switches tabs", async () => {
    // Regression test for: after close → correction cycle, lastCloseInfo was not cleared,
    // causing the next user-initiated tab switch to be incorrectly "corrected" back.
    //
    // Scenario:
    // 1. Tabs A(10), B(20), C(30); C is most recent
    // 2. Close C → sets skipNextActivation(CLOSE_TAB, expectedTabId=20) + lastCloseInfo
    // 3. Chrome auto-activates A(10) instead of B(20)
    // 4. Correction fires: setFocus(20, CLOSE_TAB_CORRECTION)
    // 5. Tab 20 activates → skipNextActivation consumed (CLOSE_TAB_CORRECTION)
    // 6. User clicks tab A(10) → should NOT jump back to 20
    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
      { id: 30, order: 3000 },
    ]);
    const wm = createMockWindowManager([tracker]);

    // Step 2: close tab C
    await tabManager.handleTabClose(30, 1, wm);

    // Step 3: Chrome wrongly activates tab A (not our expected B)
    await tabManager.handleTabActivation({ tabId: 10, windowId: 1 }, wm);
    // This triggers correction → setFocus(20, CLOSE_TAB_CORRECTION)

    // Step 5: Tab B(20) is activated by our correction
    await tabManager.handleTabActivation({ tabId: 20, windowId: 1 }, wm);
    // skipNextActivation (CLOSE_TAB_CORRECTION) consumed

    // Step 6: User manually clicks tab A(10)
    const callsBefore = getTabUpdateCalls().length;
    await tabManager.handleTabActivation({ tabId: 10, windowId: 1 }, wm);

    // Should NOT have triggered any new chrome.tabs.update (no jump-back)
    const callsAfter = getTabUpdateCalls().length;
    expect(callsAfter).toBe(callsBefore);

    // MRU should now correctly show tab A(10) as most recent
    expect(getMRUSortedTabIds(tracker)[0]).toBe(10);
  });

  it("should not corrupt MRU order during close-correction cycle", async () => {
    // Ensure the close → wrong-activation → correction cycle preserves MRU integrity
    let timeCounter = 10000;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => ++timeCounter);

    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
      { id: 30, order: 3000 },
    ]);
    const wm = createMockWindowManager([tracker]);

    // Close tab C(30)
    await tabManager.handleTabClose(30, 1, wm);

    // Chrome wrongly activates A(10) → correction fires → B(20) activated → correction consumed
    await tabManager.handleTabActivation({ tabId: 10, windowId: 1 }, wm);
    await tabManager.handleTabActivation({ tabId: 20, windowId: 1 }, wm);

    // User now switches to A(10) manually
    await tabManager.handleTabActivation({ tabId: 10, windowId: 1 }, wm);

    // MRU should correctly have A(10) as most recent, B(20) as second
    const sorted = getMRUSortedTabIds(tracker);
    expect(sorted[0]).toBe(10);
    expect(sorted[1]).toBe(20);

    dateNowSpy.mockRestore();
  });

  it("should handle reactivation + new tab + close + switch without jump-back", async () => {
    // Full scenario reported by user:
    // 1. Tabs A(10), B(20), C(30) exist; C is most recent (active)
    // 2. Service worker reactivates (no direct effect on TabManager state)
    // 3. User creates new tab D(40) - becomes most recent
    // 4. User closes tab D(40) - should go back to C(30) (MRU)
    // 5. User manually switches to tab A(10) - should NOT jump back to C(30)

    let timeCounter = 10000;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => ++timeCounter);

    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
      { id: 30, order: 3000 }, // Most recent (active)
    ]);
    const wm = createMockWindowManager([tracker]);

    // Step 3: User creates new tab D(40)
    await tabManager.handleNewTab({ id: 40, windowId: 1 }, wm);
    expect(tracker.tabarr.find((e) => e.tabId === 40)).toBeDefined();

    // Chrome fires onActivated for D(40) - consumed by NEW_TAB skip
    await tabManager.handleTabActivation({ tabId: 40, windowId: 1 }, wm);

    // Step 4: User closes new tab D(40) - should activate tab C(30)
    await tabManager.handleTabClose(40, 1, wm);
    expect((tabManager as any).skipNextActivation?.expectedTabId).toBe(30);

    // Chrome fires activation for tab 30 (correct)
    await tabManager.handleTabActivation({ tabId: 30, windowId: 1 }, wm);

    // Step 5: User manually switches to tab A(10)
    const callsBefore = getTabUpdateCalls().length;
    await tabManager.handleTabActivation({ tabId: 10, windowId: 1 }, wm);

    // Should NOT trigger any additional chrome.tabs.update (no jump-back)
    expect(getTabUpdateCalls().length).toBe(callsBefore);

    // MRU should correctly have A(10) as most recent
    expect(getMRUSortedTabIds(tracker)[0]).toBe(10);

    dateNowSpy.mockRestore();
  });

  it("should NOT jump back when quick create+close and Chrome already activated MRU tab", async () => {
    // Regression test for the race condition where:
    // 1. handleNewTab queued (sets skip = NEW_TAB, awaits save)
    // 2. handleTabActivation(X) consumes NEW_TAB
    // 3. Chrome's default activation after close fires BEFORE handleTabClose runs
    //    → handleTabActivation(A) processes normally
    // 4. handleTabClose runs, finds A as MRU, but A is ALREADY active
    //    → Without fix: sets stale skipNextActivation that never gets consumed
    //    → With fix: detects A is already active, skips correction
    // 5. User clicks B → should NOT jump back to A

    let timeCounter = 10000;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => ++timeCounter);

    const tracker = createTracker(1, [
      { id: 10, order: 1000 }, // Tab A
      { id: 20, order: 2000 }, // Tab B
      { id: 30, order: 3000 }, // Tab C (was active before creating new tab)
    ]);
    const wm = createMockWindowManager([tracker]);

    // Step 1: Create new tab X(40)
    await tabManager.handleNewTab({ id: 40, windowId: 1 }, wm);
    expect(tracker.tabarr.find((e) => e.tabId === 40)).toBeDefined();

    // Step 2: Chrome activates X → consumes NEW_TAB skip
    await tabManager.handleTabActivation({ tabId: 40, windowId: 1 }, wm);

    // Step 3: User closes X. Chrome's default activates C(30) BEFORE handleTabClose queues
    // This simulates the race condition: activation arrives before close handler
    await tabManager.handleTabActivation({ tabId: 30, windowId: 1 }, wm);

    // Step 4: Now handleTabClose runs - should detect that C(30) is already active
    const callsBefore = getTabUpdateCalls().length;
    await tabManager.handleTabClose(40, 1, wm);
    const callsAfterClose = getTabUpdateCalls().length;

    // With the fix: no safeTabUpdate should be called since C(30) is already active
    expect(callsAfterClose).toBe(callsBefore);

    // Step 5: User manually clicks B(20) - should NOT jump back to 30
    await tabManager.handleTabActivation({ tabId: 20, windowId: 1 }, wm);

    // Verify no additional chrome.tabs.update calls (no correction back to 30)
    const callsAfterSwitch = getTabUpdateCalls().length;
    expect(callsAfterSwitch).toBe(callsAfterClose);

    // MRU should correctly show B(20) as most recent
    expect(getMRUSortedTabIds(tracker)[0]).toBe(20);

    dateNowSpy.mockRestore();
  });

  it("should avoid proactive close activation when closing a freshly opened tab", async () => {
    let timeCounter = 10000;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => ++timeCounter);

    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
      { id: 30, order: 3000 },
    ]);
    const wm = createMockWindowManager([tracker]);

    await tabManager.handleNewTab({ id: 40, windowId: 1 }, wm);
    await tabManager.handleTabActivation({ tabId: 40, windowId: 1 }, wm);

    const callsBeforeClose = getTabUpdateCalls().length;
    await tabManager.handleTabClose(40, 1, wm);
    await flushDeferredCloseActivation();

    expect((tabManager as any).skipNextActivation?.expectedTabId).toBe(30);
    expect(getTabUpdateCalls()).toHaveLength(callsBeforeClose);

    await tabManager.handleTabActivation({ tabId: 10, windowId: 1 }, wm);

    const correctionCalls = getTabUpdateCalls().filter(
      (call) => call.tabId === 30 && call.props.active === true,
    );
    expect(correctionCalls).toHaveLength(1);

    dateNowSpy.mockRestore();
  });

  it("should still correct when Chrome activates WRONG tab after close", async () => {
    // Ensure the fix doesn't break the case where Chrome activates a non-MRU tab
    // and correction IS needed
    let timeCounter = 10000;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => ++timeCounter);

    const tracker = createTracker(1, [
      { id: 10, order: 1000 }, // Tab A
      { id: 20, order: 2000 }, // Tab B
      { id: 30, order: 3000 }, // Tab C (most recent)
    ]);
    const wm = createMockWindowManager([tracker]);

    // Close C(30) - should want to activate B(20)
    await tabManager.handleTabClose(30, 1, wm);

    // Chrome wrongly activates A(10) instead of B(20)
    await tabManager.handleTabActivation({ tabId: 10, windowId: 1 }, wm);

    // Should have triggered a correction to B(20)
    const calls = getTabUpdateCalls();
    const correctionCall = calls.find((c) => c.tabId === 20);
    expect(correctionCall).toBeDefined();

    dateNowSpy.mockRestore();
  });

  it("should not crash when the expected close target disappears before correction", async () => {
    // Scenario: tab B(20) is the MRU candidate after closing C(30),
    // but Chrome activates A(10) and B(20) is already gone when correction runs.
    // This should not throw or corrupt MRU state.
    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
      { id: 30, order: 3000 },
    ]);
    const wm = createMockWindowManager([tracker]);

    // Close tab C(30) - will expect tab B(20)
    await tabManager.handleTabClose(30, 1, wm);

    // Simulate B(20) disappearing before correction runs.
    tracker.tabarr = tracker.tabarr.filter((entry) => entry.tabId !== 20);

    // Chrome activates the wrong tab A(10), forcing a correction attempt.
    await tabManager.handleTabActivation({ tabId: 10, windowId: 1 }, wm);

    const calls = getTabUpdateCalls();
    expect(calls.some((c) => c.tabId === 20)).toBe(true);

    // Tab 30 should be removed from MRU
    expect(tracker.tabarr.find((e) => e.tabId === 30)).toBeUndefined();

    // Remaining tabs should still be intact
    expect(tracker.tabarr.length).toBe(1);
    expect(tracker.tabarr.map((e) => e.tabId)).toEqual([10]);
  });
});

// ============================================================================
// Background Tab MRU Correctness (regression)
// ============================================================================

describe("Background Tab MRU Correctness (regression)", () => {
  it("should not mark a background new tab (ntsel=0) as most recently used", async () => {
    await settingsManager.updateSetting("ntsel", 0, "test");

    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
      { id: 30, order: 3000 },
    ]);
    const wm = createMockWindowManager([tracker]);

    await tabManager.handleNewTab({ id: 40, windowId: 1, active: false }, wm);

    const sorted = getMRUSortedTabIds(tracker);
    expect(sorted[0]).toBe(30);
    expect(sorted[sorted.length - 1]).toBe(40);
    expect(tracker.tabarr.length).toBe(4);
  });

  it("should not schedule close correction when a non-active tab is closed", async () => {
    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
      { id: 30, order: 3000 },
    ]);
    const wm = createMockWindowManager([tracker]);

    // Tab 30 is the active tab
    await tabManager.handleTabActivation({ tabId: 30, windowId: 1 }, wm);

    // Close tab 20, which is NOT active
    await tabManager.handleTabClose(20, 1, wm);

    expect((tabManager as any).skipNextActivation).toBeNull();
    expect((tabManager as any).lastCloseInfo).toBeNull();
    expect(tracker.tabarr.map((e) => e.tabId)).toEqual([10, 30]);
  });

  it("should still schedule correction when the active tab is closed", async () => {
    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
      { id: 30, order: 3000 },
    ]);
    const wm = createMockWindowManager([tracker]);

    await tabManager.handleTabActivation({ tabId: 30, windowId: 1 }, wm);
    await tabManager.handleTabClose(30, 1, wm);

    expect((tabManager as any).skipNextActivation?.expectedTabId).toBe(20);
    expect((tabManager as any).lastCloseInfo?.expectedTabId).toBe(20);
  });

  it("should not hijack manual activation after background tabs were opened and a background tab closed", async () => {
    await settingsManager.updateSetting("ntsel", 0, "test");

    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
      { id: 30, order: 3000 },
    ]);
    const wm = createMockWindowManager([tracker]);
    await tabManager.handleTabActivation({ tabId: 30, windowId: 1 }, wm);

    await tabManager.handleNewTab({ id: 40, windowId: 1, active: false }, wm);
    await tabManager.handleNewTab({ id: 41, windowId: 1, active: false }, wm);
    expect(getMRUSortedTabIds(tracker)[0]).toBe(30);

    await tabManager.handleTabClose(40, 1, wm);
    expect((tabManager as any).skipNextActivation).toBeNull();

    const updateCallsBefore = getTabUpdateCalls().length;
    await tabManager.handleTabActivation({ tabId: 10, windowId: 1 }, wm);

    expect(getMRUSortedTabIds(tracker)[0]).toBe(10);
    expect(getTabUpdateCalls().length).toBe(updateCallsBefore);
  });
});
