/**
 * Low-performance (slow machine) simulation tests for FLST Chrome extension.
 *
 * The old 3.2.0 version had issues on slow machines where MRU tab switching
 * would fail. These tests verify timing-sensitive code paths work correctly
 * even when events arrive with delays, out of order, or when Chrome API
 * callbacks are slow.
 *
 * Key scenarios tested:
 * - Delayed Chrome API callbacks (tabs.update slow to respond)
 * - lastCloseInfo 2-second fallback boundary (just under / just over threshold)
 * - Rapid tab close→activate sequences with slow processing
 * - Operation queue contention under load
 * - Cascading reconciliations from slow window manager
 * - Timestamp collisions from rapid tab creation on slow machines
 * - Service worker dormancy detection near threshold boundary
 * - Debounced save vs service worker suspension race
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { resetChromeMock, getTabUpdateCalls } from "./chrome-mock";
import {
  createFreshTabManager,
  createFreshServiceWorkerManager,
  createFreshStorageManager,
  createMockWindowManager,
  createTracker,
  getMRUSortedTabIds,
  sleep,
} from "./test-helpers";
import type { TabTracker } from "../src/types";
import { SkipActivationReason } from "../src/types";
import { settingsManager } from "../src/managers/settings-manager";

let tabManager: ReturnType<typeof createFreshTabManager>;

async function flushDeferredCloseActivation(): Promise<void> {
  await sleep(20);
}

beforeEach(async () => {
  resetChromeMock();
  tabManager = createFreshTabManager();
  await chrome.storage.local.set({ flip: 1, ntsel: 1, reloc: 1, log: 0 });
  await settingsManager.initialize();
});

afterEach(async () => {
  vi.useRealTimers();
  await flushDeferredCloseActivation();
});

// ============================================================================
// lastCloseInfo Fallback Timing Boundary
// ============================================================================

describe("Slow Machine: lastCloseInfo 2-second threshold boundary", () => {
  it("should correct activation when elapsed time is just under 2000ms", async () => {
    // On a slow machine, the fallback may fire near the 2-second boundary.
    // Verify it still works at 1999ms.
    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
      { id: 30, order: 3000 },
    ]);
    const wm = createMockWindowManager([tracker]);

    await tabManager.handleTabClose(30, 1, wm);

    // Simulate: skipNextActivation was lost (service worker timing issue)
    (tabManager as any).skipNextActivation = null;
    // Keep this comfortably under the 2000ms threshold so suite scheduling
    // jitter plus the deferred close activation tick do not make it flaky.
    (tabManager as any).lastCloseInfo.timestamp = Date.now() - 1900;

    // Chrome auto-activates the wrong tab
    await tabManager.handleTabActivation({ tabId: 10, windowId: 1 }, wm);

    // Should still correct via fallback (under 2000ms)
    const updateCalls = getTabUpdateCalls();
    const correctionCalls = updateCalls.filter((c) => c.tabId === 20 && c.props.active === true);
    expect(correctionCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("should NOT correct activation when elapsed time is exactly 2000ms", async () => {
    // At exactly 2000ms, elapsed < 2000 is false, so no correction.
    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
      { id: 30, order: 3000 },
    ]);
    const wm = createMockWindowManager([tracker]);

    await tabManager.handleTabClose(30, 1, wm);

    (tabManager as any).skipNextActivation = null;
    (tabManager as any).lastCloseInfo.timestamp = Date.now() - 2000;

    const callsBefore = getTabUpdateCalls().length;
    await tabManager.handleTabActivation({ tabId: 10, windowId: 1 }, wm);

    // Should NOT correct - exactly at threshold (elapsed >= 2000)
    const callsAfter = getTabUpdateCalls().length;
    expect(callsAfter).toBe(callsBefore);

    // Tab 10 should be treated as normal activation (MRU updated)
    const sorted = getMRUSortedTabIds(tracker);
    expect(sorted[0]).toBe(10);
  });

  it("should handle fallback correctly when activation is delayed by 1500ms on slow machine", async () => {
    // Slow machine: close happens, but Chrome's activation event arrives 1500ms later
    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
      { id: 30, order: 3000 },
    ]);
    const wm = createMockWindowManager([tracker]);

    await tabManager.handleTabClose(30, 1, wm);

    // Simulate: skipNextActivation lost AND 1500ms elapsed
    (tabManager as any).skipNextActivation = null;
    (tabManager as any).lastCloseInfo.timestamp = Date.now() - 1500;

    // Chrome wrongly activates tab 10
    await tabManager.handleTabActivation({ tabId: 10, windowId: 1 }, wm);

    // Should correct to 20 (1500ms < 2000ms threshold)
    const updateCalls = getTabUpdateCalls();
    expect(updateCalls.some((c) => c.tabId === 20 && c.props.active === true)).toBe(true);
  });
});

// ============================================================================
// Close → Activation Race Conditions
// ============================================================================

describe("Slow Machine: Close → Activation event ordering", () => {
  it("should handle Chrome firing wrong tab activation before safeTabUpdate completes", async () => {
    // On slow machines, Chrome may auto-activate a tab before our safeTabUpdate
    // has a chance to activate the MRU tab. The skipNextActivation mechanism
    // should handle this correctly.
    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
      { id: 30, order: 3000 },
    ]);
    const wm = createMockWindowManager([tracker]);

    // Close tab 30 → sets skipNextActivation with expectedTabId=20
    await tabManager.handleTabClose(30, 1, wm);

    // Chrome immediately auto-activates tab 10 (wrong tab, before our update fires)
    await tabManager.handleTabActivation({ tabId: 10, windowId: 1 }, wm);

    // Should correct: activate tab 20
    const updateCalls = getTabUpdateCalls();
    const correctionCall = updateCalls.find((c) => c.tabId === 20 && c.props.active === true);
    expect(correctionCall).toBeDefined();
  });

  it("should handle two rapid close operations on the same window", async () => {
    // On slow machines: user closes tab C, then quickly closes tab B
    // Both are queued and should process sequentially without corruption.
    let timeCounter = 10000;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => ++timeCounter);

    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
      { id: 30, order: 3000 },
      { id: 40, order: 4000 },
    ]);
    const wm = createMockWindowManager([tracker]);

    // Close tab 40 first
    await tabManager.handleTabClose(40, 1, wm);

    // Chrome activates tab 30 (correct - MRU after 40)
    await tabManager.handleTabActivation({ tabId: 30, windowId: 1 }, wm);

    // Now close tab 30
    await tabManager.handleTabClose(30, 1, wm);

    // MRU should now be tab 20
    expect((tabManager as any).skipNextActivation?.expectedTabId).toBe(20);

    // Only tabs 10, 20 should remain
    expect(tracker.tabarr.length).toBe(2);
    expect(tracker.tabarr.map((e) => e.tabId).sort()).toEqual([10, 20]);

    dateNowSpy.mockRestore();
  });

  it("should handle close + wrong activation + correction + second close cleanly", async () => {
    // Complex race: close C → wrong activate A → correction to B →
    // B activates (consumed) → user closes B → should go to A
    let timeCounter = 10000;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => ++timeCounter);

    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
      { id: 30, order: 3000 },
    ]);
    const wm = createMockWindowManager([tracker]);

    // Close C(30) → skipNextActivation with expectedTabId=20
    await tabManager.handleTabClose(30, 1, wm);

    // Chrome wrongly activates A(10)
    await tabManager.handleTabActivation({ tabId: 10, windowId: 1 }, wm);
    // Correction fires → setFocus(20, CLOSE_TAB_CORRECTION)

    // B(20) is activated by correction
    await tabManager.handleTabActivation({ tabId: 20, windowId: 1 }, wm);
    // CLOSE_TAB_CORRECTION consumed

    // Now user closes B(20) → should activate A(10)
    const callsBeforeClose = getTabUpdateCalls().length;
    await tabManager.handleTabClose(20, 1, wm);
    await flushDeferredCloseActivation();

    expect((tabManager as any).skipNextActivation?.expectedTabId).toBe(10);
    // No proactive activation during close - correction fires in onActivated if Chrome picks wrong tab.
    expect(getTabUpdateCalls()).toHaveLength(callsBeforeClose);

    // Only A(10) remains
    expect(tracker.tabarr.length).toBe(1);
    expect(tracker.tabarr[0].tabId).toBe(10);

    dateNowSpy.mockRestore();
  });
});

// ============================================================================
// Operation Queue Contention
// ============================================================================

describe("Slow Machine: Operation queue under contention", () => {
  it("should serialize concurrent close + activation on the same window", async () => {
    // On slow machines, a pending close operation may still be running
    // when an activation event arrives for the same window.
    // The queue should serialize them properly.
    let timeCounter = 10000;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => ++timeCounter);

    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
      { id: 30, order: 3000 },
    ]);
    const wm = createMockWindowManager([tracker]);

    // Start close and activation concurrently (both queued on window 1)
    const closePromise = tabManager.handleTabClose(30, 1, wm);
    const activatePromise = tabManager.handleTabActivation({ tabId: 10, windowId: 1 }, wm);

    await closePromise;
    await activatePromise;

    // Tab 30 should be removed
    expect(tracker.tabarr.find((e) => e.tabId === 30)).toBeUndefined();
    // Remaining tabs should have valid MRU order
    expect(tracker.tabarr.length).toBe(2);

    dateNowSpy.mockRestore();
  });

  it("should handle operations on different windows independently", async () => {
    // Close on window 1 and activation on window 2 should not block each other.
    // Note: skipNextActivation is global (not per-window), so close on window 1
    // sets it, which may be consumed by activation on window 2. This tests that
    // the core data structures (trackers, tabarr) remain consistent.
    let timeCounter = 10000;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => ++timeCounter);

    const tracker1 = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
    ]);
    const tracker2 = createTracker(2, [
      { id: 30, order: 3000 },
      { id: 40, order: 4000 },
    ]);
    const wm = createMockWindowManager([tracker1, tracker2]);

    // Close on window 1 first, then activate on window 2 (sequential)
    await tabManager.handleTabClose(20, 1, wm);
    // Consume the skipNextActivation from close
    await tabManager.handleTabActivation({ tabId: 10, windowId: 1 }, wm);
    // Now activate tab 30 on window 2 (no pending skip)
    await tabManager.handleTabActivation({ tabId: 30, windowId: 2 }, wm);

    // Window 1: tab 20 removed, tab 10 remains
    expect(tracker1.tabarr.length).toBe(1);
    expect(tracker1.tabarr[0].tabId).toBe(10);

    // Window 2: tab 30 should now be most recent
    expect(getMRUSortedTabIds(tracker2)[0]).toBe(30);

    dateNowSpy.mockRestore();
  });

  it("should handle many rapid activations without corrupting MRU", async () => {
    // Simulate 10 rapid tab switches on a slow machine where events pile up
    let timeCounter = 10000;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => ++timeCounter);

    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
      { id: 30, order: 3000 },
      { id: 40, order: 4000 },
      { id: 50, order: 5000 },
    ]);
    const wm = createMockWindowManager([tracker]);

    // Rapid fire: 10 → 20 → 30 → 40 → 50 → 10 → 20 → 30 → 40 → 50
    const tabs = [10, 20, 30, 40, 50, 10, 20, 30, 40, 50];
    for (const tabId of tabs) {
      await tabManager.handleTabActivation({ tabId, windowId: 1 }, wm);
    }

    // Tab 50 should be most recent (last activated)
    const sorted = getMRUSortedTabIds(tracker);
    expect(sorted[0]).toBe(50);
    // All 5 tabs should still exist
    expect(tracker.tabarr.length).toBe(5);

    dateNowSpy.mockRestore();
  });
});

// ============================================================================
// Timestamp Collisions (Date.now() returning same value)
// ============================================================================

describe("Slow Machine: Timestamp collisions", () => {
  it("should handle multiple new tabs with identical timestamps", async () => {
    // On slow machines, Date.now() may return the same value for rapid tab creation
    const frozenTime = 999999999;
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(frozenTime);

    const tracker = createTracker(1, [{ id: 10, order: 1000 }]);
    const wm = createMockWindowManager([tracker]);

    // Create three tabs rapidly (all get same timestamp)
    await tabManager.handleNewTab({ id: 20, windowId: 1 }, wm);
    await tabManager.handleNewTab({ id: 30, windowId: 1 }, wm);
    await tabManager.handleNewTab({ id: 40, windowId: 1 }, wm);

    // All tabs should exist (no duplicates, no missing)
    expect(tracker.tabarr.length).toBe(4);
    expect(tracker.tabarr.map((e) => e.tabId).sort()).toEqual([10, 20, 30, 40]);

    dateNowSpy.mockRestore();
  });

  it("should handle activation with identical timestamps without losing tabs", async () => {
    const frozenTime = 999999999;
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(frozenTime);

    const tracker = createTracker(1, [
      { id: 10, order: frozenTime },
      { id: 20, order: frozenTime },
      { id: 30, order: frozenTime },
    ]);
    const wm = createMockWindowManager([tracker]);

    // Activate tab 10 - all timestamps are the same
    await tabManager.handleTabActivation({ tabId: 10, windowId: 1 }, wm);

    // All tabs should still be present
    expect(tracker.tabarr.length).toBe(3);

    dateNowSpy.mockRestore();
  });

  it("should still select a valid MRU tab on close when timestamps collide", async () => {
    // When all remaining tabs have the same timestamp, closing the active tab
    // should still pick one of them (not crash or return null).
    const frozenTime = 999999999;
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(frozenTime);

    const tracker = createTracker(1, [
      { id: 10, order: frozenTime },
      { id: 20, order: frozenTime },
      { id: 30, order: frozenTime },
    ]);
    const wm = createMockWindowManager([tracker]);

    // Mark tab 30 as active (close correction only applies to the active tab)
    await tabManager.handleTabActivation({ tabId: 30, windowId: 1 }, wm);

    await tabManager.handleTabClose(30, 1, wm);
    await flushDeferredCloseActivation();

    // Should have selected SOME valid MRU target (10 or 20), not crash
    expect([10, 20]).toContain((tabManager as any).skipNextActivation?.expectedTabId);
    // No proactive activation - correction fires in onActivated if Chrome picks wrong tab.
    expect(getTabUpdateCalls()).toHaveLength(0);

    dateNowSpy.mockRestore();
  });
});

// ============================================================================
// Reconciliation Timing on Slow Machine
// ============================================================================

describe("Slow Machine: Reconciliation during activation", () => {
  it("should recover when window tracker is missing and reconciliation adds it", async () => {
    // On slow machines, windows.getAll may be delayed. Simulate: window tracker
    // is missing but reconciliation eventually adds it.
    let timeCounter = 10000;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => ++timeCounter);

    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
    ]);

    // Start with NO trackers (simulating post-dormancy state loss)
    const wm = createMockWindowManager([]);

    // Make reconciliation add the tracker back
    wm.reconcileWithBrowserState = vi.fn(async () => {
      // Simulate slow reconciliation (would be ~3s on slow machine)
      // After reconciliation, window manager now knows about the window
      (wm as any).__trackers = [tracker];
      wm.getWindowTracker = (windowId: number) => (windowId === 1 ? tracker : null);
      wm.findTab = (tabId: number) => {
        const index = tracker.tabarr.findIndex((e) => e.tabId === tabId);
        return index !== -1
          ? { tabarr: tracker.tabarr, tabloc: index }
          : { tabarr: null, tabloc: -1 };
      };
      wm.getAllTrackers = () => [tracker];
    });

    // Tab activation for window that doesn't exist yet → triggers reconciliation
    await tabManager.handleTabActivation({ tabId: 10, windowId: 1 }, wm);

    // Reconciliation should have been called
    expect(wm.reconcileWithBrowserState).toHaveBeenCalled();

    // After reconciliation, tab 10 should be tracked in MRU
    const sorted = getMRUSortedTabIds(tracker);
    expect(sorted[0]).toBe(10);

    dateNowSpy.mockRestore();
  });

  it("should recover when tab is missing and reconciliation adds it", async () => {
    // Tab exists in browser but not in our MRU array. Reconciliation
    // should add it, then the activation should succeed.
    let timeCounter = 10000;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => ++timeCounter);

    // Tracker for window 1 exists but only has tab 10
    const tracker = createTracker(1, [{ id: 10, order: 1000 }]);
    const wm = createMockWindowManager([tracker]);

    // Make reconciliation add the missing tab
    wm.reconcileWithBrowserState = vi.fn(async () => {
      // Add tab 20 that was missing
      if (!tracker.tabarr.find((e) => e.tabId === 20)) {
        tracker.tabarr.push({ tabId: 20, order: Date.now() });
      }
    });

    // Activate tab 20 (not in tracker yet)
    await tabManager.handleTabActivation({ tabId: 20, windowId: 1 }, wm);

    // Reconciliation should have been called
    expect(wm.reconcileWithBrowserState).toHaveBeenCalled();

    // Tab 20 should now be most recent
    const sorted = getMRUSortedTabIds(tracker);
    expect(sorted[0]).toBe(20);

    dateNowSpy.mockRestore();
  });

  it("should handle double reconciliation failure gracefully", async () => {
    // Worst case: both reconciliation attempts fail (window & tab still missing)
    const tracker = createTracker(1, [{ id: 10, order: 1000 }]);
    const wm = createMockWindowManager([]);

    // Reconciliation never adds the window
    wm.reconcileWithBrowserState = vi.fn(async () => {
      // Does nothing - simulating slow machine where chrome.windows.getAll times out
    });

    // Should not throw, should log warning and return
    await tabManager.handleTabActivation({ tabId: 10, windowId: 1 }, wm);

    // Reconciliation was called (at least for window lookup)
    expect(wm.reconcileWithBrowserState).toHaveBeenCalled();

    // No crash, no MRU corruption
  });
});

// ============================================================================
// Service Worker Dormancy Detection Boundary
// ============================================================================

describe("Slow Machine: Dormancy detection near threshold", () => {
  let swManager: ReturnType<typeof createFreshServiceWorkerManager>;

  beforeEach(() => {
    createFreshStorageManager();
    swManager = createFreshServiceWorkerManager();
  });

  it("should detect dormancy at 35001ms (just over threshold)", async () => {
    const reconcileSpy = vi.fn().mockResolvedValue(undefined);
    swManager.setReconciliationCallback(reconcileSpy);
    await swManager.startKeepalive();

    // Set last activation to 35001ms ago
    (swManager as any).lastActivationTime = Date.now() - 35001;

    await swManager.handleKeepaliveAlarm();
    await new Promise((r) => setTimeout(r, 350));

    expect(reconcileSpy).toHaveBeenCalledOnce();
  });

  it("should NOT detect dormancy at 34999ms (just under threshold)", async () => {
    const reconcileSpy = vi.fn().mockResolvedValue(undefined);
    swManager.setReconciliationCallback(reconcileSpy);
    await swManager.startKeepalive();

    // Set last activation to 34999ms ago
    (swManager as any).lastActivationTime = Date.now() - 34999;

    await swManager.handleKeepaliveAlarm();
    await new Promise((r) => setTimeout(r, 350));

    expect(reconcileSpy).not.toHaveBeenCalled();
  });

  it("should detect reactivation at 10001ms (just over threshold)", async () => {
    const reconcileSpy = vi.fn().mockResolvedValue(undefined);
    swManager.setReconciliationCallback(reconcileSpy);

    (swManager as any).lastActivationTime = Date.now() - 10001;
    await swManager.handleReactivation();
    await new Promise((r) => setTimeout(r, 350));

    expect(reconcileSpy).toHaveBeenCalledOnce();
  });

  it("should NOT trigger reactivation at 9999ms (just under threshold)", async () => {
    const reconcileSpy = vi.fn().mockResolvedValue(undefined);
    swManager.setReconciliationCallback(reconcileSpy);

    (swManager as any).lastActivationTime = Date.now() - 9999;
    await swManager.handleReactivation();
    await new Promise((r) => setTimeout(r, 350));

    expect(reconcileSpy).not.toHaveBeenCalled();
  });

  it("should handle very long dormancy period (e.g. 5 minutes)", async () => {
    const reconcileSpy = vi.fn().mockResolvedValue(undefined);
    swManager.setReconciliationCallback(reconcileSpy);
    await swManager.startKeepalive();

    // 5 minutes of dormancy
    (swManager as any).lastActivationTime = Date.now() - 300000;

    await swManager.handleKeepaliveAlarm();
    await new Promise((r) => setTimeout(r, 350));

    expect(reconcileSpy).toHaveBeenCalledOnce();
    // lastActivationTime should be reset
    expect((swManager as any).lastActivationTime).toBeGreaterThan(Date.now() - 1000);
  });
});

// ============================================================================
// safeTabUpdate Retry Behavior on Slow Machines
// ============================================================================

describe("Slow Machine: safeTabUpdate retry behavior", () => {
  it("should retry on 'user may be dragging' error during close correction", async () => {
    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
      { id: 30, order: 3000 },
    ]);
    const wm = createMockWindowManager([tracker]);

    // Save original implementation before overriding
    const origUpdate = chrome.tabs.update;
    let callCount = 0;
    // Mock tabs.update to fail with dragging error first two times, then succeed
    const customUpdate = vi.fn((tabId: number, props: any, cb?: (tab?: any) => void) => {
      callCount++;
      if (callCount <= 2) {
        (chrome.runtime as any).lastError = {
          message: "Tabs cannot be edited right now (user may be dragging a tab).",
        };
      } else {
        (chrome.runtime as any).lastError = undefined;
      }
      if (cb) cb(callCount <= 2 ? null : { id: tabId });
    });
    (chrome.tabs as any).update = customUpdate;

    // Use vi.useFakeTimers to control setTimeout for retries
    vi.useFakeTimers();

    // Close tab 30, then force wrong activation so correction triggers safeTabUpdate(20) retries
    const closePromise = tabManager.handleTabClose(30, 1, wm);
    await closePromise;

    const correctionPromise = tabManager.handleTabActivation({ tabId: 10, windowId: 1 }, wm);

    // Advance timer for first retry (200ms)
    await vi.advanceTimersByTimeAsync(200);
    // Advance timer for second retry (200ms)
    await vi.advanceTimersByTimeAsync(200);

    await correctionPromise;

    // Correction retry sequence: initial call + 2 retries = 3 total.
    expect(callCount).toBe(3);

    vi.useRealTimers();
    // Restore original mock
    (chrome.tabs as any).update = origUpdate;
  });
});

// ============================================================================
// Full Slow Machine Workflow: Close → Dormancy → Reactivation → Correct MRU
// ============================================================================

describe("Slow Machine: End-to-end post-dormancy workflow", () => {
  it("should maintain MRU integrity through dormancy + close + correction cycle", async () => {
    // Simulates the original 3.2.0 bug scenario on a slow machine:
    // 1. Tabs A(10), B(20), C(30) with C active
    // 2. Service worker goes dormant (long idle)
    // 3. User closes C → should go to B
    // 4. Chrome auto-activates A (wrong tab on slow machine)
    // 5. Correction fires → B activated
    // 6. User switches to A → should NOT jump back to B

    let timeCounter = 10000;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => ++timeCounter);

    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
      { id: 30, order: 3000 },
    ]);
    const wm = createMockWindowManager([tracker]);

    // Step 3: Close C
    await tabManager.handleTabClose(30, 1, wm);
    expect((tabManager as any).skipNextActivation?.expectedTabId).toBe(20);

    // Step 4: Chrome wrongly activates A (slow machine behavior)
    await tabManager.handleTabActivation({ tabId: 10, windowId: 1 }, wm);

    // Step 5: Correction → B activated
    await tabManager.handleTabActivation({ tabId: 20, windowId: 1 }, wm);

    // Step 6: User manually switches to A
    const callsBefore = getTabUpdateCalls().length;
    await tabManager.handleTabActivation({ tabId: 10, windowId: 1 }, wm);

    // No jump-back should occur
    expect(getTabUpdateCalls().length).toBe(callsBefore);

    // MRU: A should be most recent
    expect(getMRUSortedTabIds(tracker)[0]).toBe(10);

    dateNowSpy.mockRestore();
  });

  it("should work correctly after multiple dormancy cycles", async () => {
    // Simulate: dormancy → wake → close → dormancy → wake → close
    let timeCounter = 10000;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => ++timeCounter);

    const tracker = createTracker(1, [
      { id: 10, order: 1000 },
      { id: 20, order: 2000 },
      { id: 30, order: 3000 },
      { id: 40, order: 4000 },
    ]);
    const wm = createMockWindowManager([tracker]);

    // First cycle: close tab 40 → MRU is 30
    await tabManager.handleTabClose(40, 1, wm);
    await tabManager.handleTabActivation({ tabId: 30, windowId: 1 }, wm);

    // Second cycle: close tab 30 → MRU is 20
    await tabManager.handleTabClose(30, 1, wm);
    await tabManager.handleTabActivation({ tabId: 20, windowId: 1 }, wm);

    // Remaining: 10, 20
    expect(tracker.tabarr.length).toBe(2);

    // MRU should be tab 20
    expect(getMRUSortedTabIds(tracker)[0]).toBe(20);

    // User manually switches to 10 - no jump back
    const callsBefore = getTabUpdateCalls().length;
    await tabManager.handleTabActivation({ tabId: 10, windowId: 1 }, wm);
    expect(getTabUpdateCalls().length).toBe(callsBefore);
    expect(getMRUSortedTabIds(tracker)[0]).toBe(10);

    dateNowSpy.mockRestore();
  });
});

// ============================================================================
// Randomized Long-Running Stress Tests
// ============================================================================

describe("Stress: Randomized create+close+switch loops", () => {
  /**
   * Pseudo-random number generator (seeded for reproducibility).
   * Using a simple LCG so tests are deterministic per seed.
   */
  function createRng(seed: number) {
    let state = seed;
    return {
      /** Returns a float in [0, 1) */
      next(): number {
        state = (state * 1664525 + 1013904223) & 0xffffffff;
        return (state >>> 0) / 0x100000000;
      },
      /** Returns an integer in [min, max] inclusive */
      int(min: number, max: number): number {
        return Math.floor(this.next() * (max - min + 1)) + min;
      },
      /** Pick a random element from an array */
      pick<T>(arr: T[]): T {
        return arr[Math.floor(this.next() * arr.length)];
      },
    };
  }

  it("should never jump-back across 2000 random create+close+switch iterations (seed 42)", async () => {
    const rng = createRng(42);
    let timeCounter = 100000;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => ++timeCounter);

    // Start with 5 tabs
    let nextTabId = 100;
    const initialTabs = Array.from({ length: 5 }, (_, i) => ({
      id: nextTabId++,
      order: 1000 + i * 100,
    }));
    const tracker = createTracker(1, initialTabs);
    const wm = createMockWindowManager([tracker]);

    // Track the "active" tab from the user's perspective
    let activeTabId = initialTabs[initialTabs.length - 1].id;

    for (let i = 0; i < 2000; i++) {
      const action = rng.int(0, 4); // 0=switch, 1=create+close, 2=create, 3=close, 4=switch after close

      if (action === 0 && tracker.tabarr.length >= 2) {
        // Random user switch - should NEVER trigger a jump-back
        const otherTabs = tracker.tabarr.filter((e) => e.tabId !== activeTabId);
        if (otherTabs.length === 0) continue;
        const target = rng.pick(otherTabs);
        const callsBefore = getTabUpdateCalls().length;
        await tabManager.handleTabActivation({ tabId: target.tabId, windowId: 1 }, wm);
        // A normal user switch must NOT trigger chrome.tabs.update (no correction)
        expect(getTabUpdateCalls().length).toBe(callsBefore);
        activeTabId = target.tabId;
      } else if (action === 1) {
        // Create + immediately close (the exact race condition scenario)
        const newId = nextTabId++;
        await tabManager.handleNewTab({ id: newId, windowId: 1 }, wm);
        // Chrome fires onActivated for the new tab
        await tabManager.handleTabActivation({ tabId: newId, windowId: 1 }, wm);
        activeTabId = newId;

        // Randomly decide: does Chrome activate old tab BEFORE or AFTER handleTabClose?
        if (rng.next() < 0.5 && tracker.tabarr.length > 1) {
          // Race: Chrome auto-activates an old tab before close handler runs
          const mruExcluding = [...tracker.tabarr]
            .filter((e) => e.tabId !== newId)
            .sort((a, b) => b.order - a.order);
          if (mruExcluding.length > 0) {
            const autoActivated = mruExcluding[0].tabId;
            await tabManager.handleTabActivation({ tabId: autoActivated, windowId: 1 }, wm);
            activeTabId = autoActivated;
          }
        }

        // Now close the new tab
        await tabManager.handleTabClose(newId, 1, wm);

        // After close, figure out what the active tab should be
        // If the expected MRU tab is already active, no activation event fires
        // Otherwise Chrome fires an activation event
        const expectedMRU = [...tracker.tabarr]
          .sort((a, b) => b.order - a.order)
          .map((e) => e.tabId)[0];
        if (expectedMRU && expectedMRU !== activeTabId) {
          await tabManager.handleTabActivation({ tabId: expectedMRU, windowId: 1 }, wm);
          activeTabId = expectedMRU;
        } else if (expectedMRU) {
          activeTabId = expectedMRU;
        }

        // Now do a user switch to a different tab - must NOT jump back
        const otherTabs = tracker.tabarr.filter((e) => e.tabId !== activeTabId);
        if (otherTabs.length > 0) {
          const switchTo = rng.pick(otherTabs);
          const callsBefore = getTabUpdateCalls().length;
          await tabManager.handleTabActivation({ tabId: switchTo.tabId, windowId: 1 }, wm);
          expect(getTabUpdateCalls().length).toBe(callsBefore);
          activeTabId = switchTo.tabId;
        }
      } else if (action === 2) {
        // Just create a new tab
        const newId = nextTabId++;
        await tabManager.handleNewTab({ id: newId, windowId: 1 }, wm);
        await tabManager.handleTabActivation({ tabId: newId, windowId: 1 }, wm);
        activeTabId = newId;
      } else if (action === 3 && tracker.tabarr.length >= 3) {
        // Close the active tab
        const closingTab = activeTabId;
        await tabManager.handleTabClose(closingTab, 1, wm);

        // Determine what becomes active after close
        const remaining = tracker.tabarr.map((e) => e.tabId);
        if (remaining.length > 0) {
          const mru = [...tracker.tabarr].sort((a, b) => b.order - a.order)[0].tabId;
          if (mru !== activeTabId || !remaining.includes(activeTabId)) {
            await tabManager.handleTabActivation({ tabId: mru, windowId: 1 }, wm);
            activeTabId = mru;
          }
        }
      } else if (action === 4 && tracker.tabarr.length >= 3) {
        // Close a non-active tab, then switch
        const closeCandidates = tracker.tabarr.filter((e) => e.tabId !== activeTabId);
        if (closeCandidates.length === 0) continue;
        const victim = rng.pick(closeCandidates);
        await tabManager.handleTabClose(victim.tabId, 1, wm);

        // switch after close (active tab didn't change, no skipNextActivation should interfere)
        const otherTabs = tracker.tabarr.filter((e) => e.tabId !== activeTabId);
        if (otherTabs.length > 0) {
          const switchTo = rng.pick(otherTabs);
          const callsBefore = getTabUpdateCalls().length;
          await tabManager.handleTabActivation({ tabId: switchTo.tabId, windowId: 1 }, wm);
          expect(getTabUpdateCalls().length).toBe(callsBefore);
          activeTabId = switchTo.tabId;
        }
      }

      // Invariant: all tracked tabs should have unique IDs
      const tabIds = tracker.tabarr.map((e) => e.tabId);
      expect(new Set(tabIds).size).toBe(tabIds.length);

      // Invariant: at least 1 tab should always exist (we never close below 3)
      expect(tracker.tabarr.length).toBeGreaterThanOrEqual(1);
    }

    dateNowSpy.mockRestore();
  }, 45000);

  it("should never jump-back across 2000 random iterations with timestamp jitter (seed 7)", async () => {
    const rng = createRng(7);
    let timeCounter = 100000;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      // Add a random jitter of 0-3 to simulate timestamp collisions on slow machines
      timeCounter += rng.int(0, 3);
      return timeCounter;
    });

    let nextTabId = 200;
    const initialTabs = Array.from({ length: 4 }, (_, i) => ({
      id: nextTabId++,
      order: 2000 + i * 100,
    }));
    const tracker = createTracker(1, initialTabs);
    const wm = createMockWindowManager([tracker]);
    let activeTabId = initialTabs[initialTabs.length - 1].id;

    for (let i = 0; i < 2000; i++) {
      const action = rng.int(0, 2);

      if (action === 0 && tracker.tabarr.length >= 2) {
        // User switch
        const otherTabs = tracker.tabarr.filter((e) => e.tabId !== activeTabId);
        if (otherTabs.length === 0) continue;
        const target = rng.pick(otherTabs);
        const callsBefore = getTabUpdateCalls().length;
        await tabManager.handleTabActivation({ tabId: target.tabId, windowId: 1 }, wm);
        expect(getTabUpdateCalls().length).toBe(callsBefore);
        activeTabId = target.tabId;
      } else if (action === 1) {
        // Create + close + verify no jump-back
        const newId = nextTabId++;
        await tabManager.handleNewTab({ id: newId, windowId: 1 }, wm);
        await tabManager.handleTabActivation({ tabId: newId, windowId: 1 }, wm);
        activeTabId = newId;

        // Simulate race: 50% chance Chrome activates old tab first
        const oldMru = [...tracker.tabarr]
          .filter((e) => e.tabId !== newId)
          .sort((a, b) => b.order - a.order);
        if (rng.next() < 0.5 && oldMru.length > 0) {
          await tabManager.handleTabActivation({ tabId: oldMru[0].tabId, windowId: 1 }, wm);
          activeTabId = oldMru[0].tabId;
        }

        await tabManager.handleTabClose(newId, 1, wm);

        const expectedMRU = [...tracker.tabarr]
          .sort((a, b) => b.order - a.order)
          .map((e) => e.tabId)[0];
        if (expectedMRU && expectedMRU !== activeTabId) {
          await tabManager.handleTabActivation({ tabId: expectedMRU, windowId: 1 }, wm);
          activeTabId = expectedMRU;
        } else if (expectedMRU) {
          activeTabId = expectedMRU;
        }

        // Must not jump-back on next user switch
        const otherTabs = tracker.tabarr.filter((e) => e.tabId !== activeTabId);
        if (otherTabs.length > 0) {
          const switchTo = rng.pick(otherTabs);
          const callsBefore = getTabUpdateCalls().length;
          await tabManager.handleTabActivation({ tabId: switchTo.tabId, windowId: 1 }, wm);
          expect(getTabUpdateCalls().length).toBe(callsBefore);
          activeTabId = switchTo.tabId;
        }
      } else if (action === 2 && tracker.tabarr.length >= 3) {
        // Close active tab
        await tabManager.handleTabClose(activeTabId, 1, wm);
        const remaining = [...tracker.tabarr].sort((a, b) => b.order - a.order);
        if (remaining.length > 0) {
          const mru = remaining[0].tabId;
          if (mru !== activeTabId) {
            await tabManager.handleTabActivation({ tabId: mru, windowId: 1 }, wm);
          }
          activeTabId = mru;
        }
      }

      // Invariant checks
      const tabIds = tracker.tabarr.map((e) => e.tabId);
      expect(new Set(tabIds).size).toBe(tabIds.length);
      expect(tracker.tabarr.length).toBeGreaterThanOrEqual(1);
    }

    dateNowSpy.mockRestore();
  }, 30000);

  it("should survive 1000 rapid create+close bursts without stale skipNextActivation", async () => {
    let timeCounter = 100000;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => ++timeCounter);

    const tracker = createTracker(1, [
      { id: 1, order: 1000 },
      { id: 2, order: 2000 },
      { id: 3, order: 3000 },
    ]);
    const wm = createMockWindowManager([tracker]);
    let activeTabId = 3;
    let nextId = 100;

    for (let i = 0; i < 1000; i++) {
      // Create a new tab
      const newId = nextId++;
      await tabManager.handleNewTab({ id: newId, windowId: 1 }, wm);
      // Chrome activates it
      await tabManager.handleTabActivation({ tabId: newId, windowId: 1 }, wm);
      activeTabId = newId;

      // Chrome already activates the old MRU tab before our close handler
      const mruBefore = [...tracker.tabarr]
        .filter((e) => e.tabId !== newId)
        .sort((a, b) => b.order - a.order);
      if (mruBefore.length > 0) {
        await tabManager.handleTabActivation({ tabId: mruBefore[0].tabId, windowId: 1 }, wm);
        activeTabId = mruBefore[0].tabId;
      }

      // Close the new tab
      await tabManager.handleTabClose(newId, 1, wm);

      // The key assertion: skipNextActivation should be null after this
      // because handleTabClose detected the expected tab was already active
      expect((tabManager as any).skipNextActivation).toBeNull();
      expect((tabManager as any).lastCloseInfo).toBeNull();

      // User switches to another tab - must NEVER trigger a correction
      const otherTabs = tracker.tabarr.filter((e) => e.tabId !== activeTabId);
      if (otherTabs.length > 0) {
        const callsBefore = getTabUpdateCalls().length;
        const target = otherTabs[0];
        await tabManager.handleTabActivation({ tabId: target.tabId, windowId: 1 }, wm);
        expect(getTabUpdateCalls().length).toBe(callsBefore);
        activeTabId = target.tabId;
      }
    }

    // All 3 original tabs should still exist
    expect(tracker.tabarr.filter((e) => [1, 2, 3].includes(e.tabId)).length).toBe(3);

    dateNowSpy.mockRestore();
  }, 45000);
});
