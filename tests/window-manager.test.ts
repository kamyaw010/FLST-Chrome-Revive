/**
 * Unit tests for WindowManager - window/tab tracking and reconciliation.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { resetChromeMock, setMockWindows, setMockStorageData } from "./chrome-mock";
import { createFreshWindowManager, createFreshStorageManager } from "./test-helpers";

let windowManager: ReturnType<typeof createFreshWindowManager>;
let storageManager: ReturnType<typeof createFreshStorageManager>;

beforeEach(() => {
  resetChromeMock();
  storageManager = createFreshStorageManager();
  windowManager = createFreshWindowManager();
});

// ============================================================================
// Initialization
// ============================================================================

describe("Window Tracking Initialization", () => {
  it("should build fresh tracking from browser state when no stored state", async () => {
    setMockWindows([
      {
        id: 1,
        tabs: [
          { id: 10, active: false },
          { id: 20, active: false },
          { id: 30, active: true },
        ],
      },
    ]);

    await windowManager.initializeTracking();

    const tracker = windowManager.getWindowTracker(1);
    expect(tracker).not.toBeNull();
    expect(tracker!.tabarr.length).toBe(3);

    // Active tab (30) should be the last element in tabarr (pushed last by addWindow)
    const lastEntry = tracker!.tabarr[tracker!.tabarr.length - 1];
    expect(lastEntry.tabId).toBe(30);
  });

  it("should restore from storage if state is valid", async () => {
    setMockWindows([
      {
        id: 1,
        tabs: [
          { id: 10, active: false },
          { id: 20, active: true },
        ],
      },
    ]);

    // Pre-populate storage with valid state
    const storedState = {
      trackingState: [
        {
          wid: 1,
          moveok: true,
          tabarr: [
            { tabId: 10, order: 5000 },
            { tabId: 20, order: 9000 }, // Custom MRU order we want preserved
          ],
        },
      ],
      timestamp: Date.now() - 1000, // 1 second ago
      version: "3.3.0",
    };
    setMockStorageData({ flstState: storedState });

    await windowManager.initializeTracking();

    const tracker = windowManager.getWindowTracker(1);
    expect(tracker).not.toBeNull();
    // Should have preserved our custom MRU order
    expect(tracker!.tabarr.find((e) => e.tabId === 10)!.order).toBe(5000);
    expect(tracker!.tabarr.find((e) => e.tabId === 20)!.order).toBe(9000);
  });

  it("should rebuild state if stored state is too old (>24h)", async () => {
    setMockWindows([
      {
        id: 1,
        tabs: [{ id: 10, active: true }],
      },
    ]);

    const storedState = {
      trackingState: [
        {
          wid: 1,
          moveok: true,
          tabarr: [{ tabId: 10, order: 5000 }],
        },
      ],
      timestamp: Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago
      version: "3.3.0",
    };
    setMockStorageData({ flstState: storedState });

    await windowManager.initializeTracking();

    const tracker = windowManager.getWindowTracker(1);
    expect(tracker).not.toBeNull();
    // Order should NOT be 5000 (the stored one), should be fresh
    expect(tracker!.tabarr.find((e) => e.tabId === 10)!.order).not.toBe(5000);
  });

  it("should handle multiple windows", async () => {
    setMockWindows([
      {
        id: 1,
        tabs: [
          { id: 10, active: true },
          { id: 20, active: false },
        ],
      },
      {
        id: 2,
        tabs: [
          { id: 30, active: true },
          { id: 40, active: false },
        ],
      },
    ]);

    await windowManager.initializeTracking();

    expect(windowManager.getWindowTracker(1)).not.toBeNull();
    expect(windowManager.getWindowTracker(2)).not.toBeNull();
    expect(windowManager.getTrackingStats().windowCount).toBe(2);
    expect(windowManager.getTrackingStats().totalTabs).toBe(4);
  });
});

// ============================================================================
// Add/Remove Window
// ============================================================================

describe("Add/Remove Window", () => {
  it("should add a new window with its tabs", async () => {
    setMockWindows([]);
    await windowManager.initializeTracking();

    await windowManager.addWindow({
      id: 5,
      type: "normal",
      tabs: [
        { id: 50, active: false },
        { id: 51, active: true },
      ],
    });

    const tracker = windowManager.getWindowTracker(5);
    expect(tracker).not.toBeNull();
    expect(tracker!.tabarr.length).toBe(2);
    expect(tracker!.moveok).toBe(true);
  });

  it("should replace an existing tracker instead of creating a duplicate", async () => {
    setMockWindows([{ id: 5, tabs: [{ id: 50, active: true }] }]);
    await windowManager.initializeTracking();

    await windowManager.addWindow({
      id: 5,
      type: "normal",
      tabs: [
        { id: 50, active: false },
        { id: 51, active: true },
      ],
    });

    const trackers = windowManager.getAllTrackers().filter((tracker) => tracker.wid === 5);
    expect(trackers).toHaveLength(1);
    expect(trackers[0].tabarr.map((entry) => entry.tabId)).toEqual([50, 51]);
  });

  it("should remove window tracker on window close", async () => {
    setMockWindows([
      { id: 1, tabs: [{ id: 10, active: true }] },
      { id: 2, tabs: [{ id: 20, active: true }] },
    ]);
    await windowManager.initializeTracking();

    await windowManager.removeWindow(1);

    expect(windowManager.getWindowTracker(1)).toBeNull();
    expect(windowManager.getWindowTracker(2)).not.toBeNull();
  });
});

// ============================================================================
// Find Tab
// ============================================================================

describe("Find Tab", () => {
  it("should find tab across windows", async () => {
    setMockWindows([
      { id: 1, tabs: [{ id: 10, active: true }] },
      {
        id: 2,
        tabs: [
          { id: 20, active: false },
          { id: 30, active: true },
        ],
      },
    ]);
    await windowManager.initializeTracking();

    const info = windowManager.findTab(30);
    expect(info.tabarr).not.toBeNull();
    expect(info.tabloc).toBeGreaterThanOrEqual(0);
    expect(info.tabarr![info.tabloc].tabId).toBe(30);
  });

  it("should return null for non-existent tab", async () => {
    setMockWindows([{ id: 1, tabs: [{ id: 10, active: true }] }]);
    await windowManager.initializeTracking();

    const info = windowManager.findTab(999);
    expect(info.tabarr).toBeNull();
    expect(info.tabloc).toBe(-1);
  });
});

// ============================================================================
// Reconciliation
// ============================================================================

describe("Reconciliation", () => {
  it("should add missing tabs during reconciliation", async () => {
    // Start with only tab 10 tracked
    setMockWindows([
      {
        id: 1,
        tabs: [
          { id: 10, active: false },
          { id: 20, active: true },
        ],
      },
    ]);

    // Force init with incomplete state
    const storedState = {
      trackingState: [
        {
          wid: 1,
          moveok: true,
          tabarr: [{ tabId: 10, order: 1000 }], // Missing tab 20
        },
      ],
      timestamp: Date.now() - 500,
      version: "3.3.0",
    };
    setMockStorageData({ flstState: storedState });

    await windowManager.initializeTracking();

    // initializeTracking should reconcile because count mismatch
    const tracker = windowManager.getWindowTracker(1);
    expect(tracker).not.toBeNull();
    expect(tracker!.tabarr.length).toBe(2);
    expect(tracker!.tabarr.find((e) => e.tabId === 20)).toBeDefined();
  });

  it("should remove orphaned tabs during reconciliation", async () => {
    // Browser has only tab 10, but stored state has 10 and 20
    setMockWindows([{ id: 1, tabs: [{ id: 10, active: true }] }]);

    const storedState = {
      trackingState: [
        {
          wid: 1,
          moveok: true,
          tabarr: [
            { tabId: 10, order: 1000 },
            { tabId: 20, order: 2000 }, // Orphaned
          ],
        },
      ],
      timestamp: Date.now() - 500,
      version: "3.3.0",
    };
    setMockStorageData({ flstState: storedState });

    await windowManager.initializeTracking();

    const tracker = windowManager.getWindowTracker(1);
    expect(tracker).not.toBeNull();
    expect(tracker!.tabarr.length).toBe(1);
    expect(tracker!.tabarr[0].tabId).toBe(10);
  });

  it("should preserve existing tab order during reconciliation", async () => {
    setMockWindows([
      {
        id: 1,
        tabs: [
          { id: 10, active: false },
          { id: 20, active: false },
          { id: 30, active: true },
        ],
      },
    ]);

    // Stored state with custom MRU order but missing tab 30
    const storedState = {
      trackingState: [
        {
          wid: 1,
          moveok: true,
          tabarr: [
            { tabId: 10, order: 5000 }, // Custom order
            { tabId: 20, order: 1000 }, // Custom order
          ],
        },
      ],
      timestamp: Date.now() - 500,
      version: "3.3.0",
    };
    setMockStorageData({ flstState: storedState });

    await windowManager.initializeTracking();

    const tracker = windowManager.getWindowTracker(1);
    // Tab 10 and 20 should preserve their relative MRU order
    expect(tracker!.tabarr.find((e) => e.tabId === 10)!.order).toBe(5000);
    expect(tracker!.tabarr.find((e) => e.tabId === 20)!.order).toBe(1000);
    // Tab 30 should have been added
    expect(tracker!.tabarr.find((e) => e.tabId === 30)).toBeDefined();
  });

  it("should handle window that no longer exists", async () => {
    // Stored state has window 1 and 2, but browser only has window 1
    setMockWindows([{ id: 1, tabs: [{ id: 10, active: true }] }]);

    const storedState = {
      trackingState: [
        {
          wid: 1,
          moveok: true,
          tabarr: [{ tabId: 10, order: 1000 }],
        },
        {
          wid: 2,
          moveok: true,
          tabarr: [{ tabId: 20, order: 2000 }],
        },
      ],
      timestamp: Date.now() - 500,
      version: "3.3.0",
    };
    setMockStorageData({ flstState: storedState });

    await windowManager.initializeTracking();

    // Should only have window 1 after reconciliation
    expect(windowManager.getWindowTracker(1)).not.toBeNull();
    // Window 2 should have been cleaned up
    expect(windowManager.getAllTrackers().length).toBe(1);
  });
});

// ============================================================================
// Validation
// ============================================================================

describe("Tracking Validation", () => {
  it("should detect duplicate tabs", async () => {
    setMockWindows([
      {
        id: 1,
        tabs: [
          { id: 10, active: true },
          { id: 20, active: false },
        ],
      },
    ]);
    await windowManager.initializeTracking();

    // Manually corrupt the tracker to have duplicate
    const tracker = windowManager.getWindowTracker(1)!;
    tracker.tabarr.push({ tabId: 10, order: 9999 });

    expect(windowManager.validateTracking()).toBe(false);
  });

  it("should pass validation for clean state", async () => {
    setMockWindows([
      {
        id: 1,
        tabs: [
          { id: 10, active: true },
          { id: 20, active: false },
        ],
      },
    ]);
    await windowManager.initializeTracking();

    expect(windowManager.validateTracking()).toBe(true);
  });
});

// ============================================================================
// Popup Window Type (Vertical Tab Bar Support)
// ============================================================================

describe("Popup Window Type", () => {
  it("should set moveok=true for popup window type (vertical tab bar)", async () => {
    // Chrome's vertical tab bar mode uses popup window type internally.
    // FLST must allow tab operations (moveok=true) for popup windows.
    setMockWindows([]);
    await windowManager.initializeTracking();

    await windowManager.addWindow({
      id: 10,
      type: "popup",
      tabs: [{ id: 100, active: true }],
    });

    const tracker = windowManager.getWindowTracker(10);
    expect(tracker).not.toBeNull();
    expect(tracker!.moveok).toBe(true);
  });

  it("should set moveok=false for devtools window type", async () => {
    setMockWindows([]);
    await windowManager.initializeTracking();

    await windowManager.addWindow({
      id: 20,
      type: "devtools",
      tabs: [{ id: 200, active: true }],
    });

    const tracker = windowManager.getWindowTracker(20);
    expect(tracker).not.toBeNull();
    expect(tracker!.moveok).toBe(false);
  });
});

// ============================================================================
// Reconciliation - background tab recency
// ============================================================================

describe("Reconciliation Background Tab Recency (regression)", () => {
  it("should assign strip-order recency when building fresh state", async () => {
    setMockWindows([
      {
        id: 1,
        tabs: [
          { id: 10, active: false },
          { id: 20, active: false },
          { id: 30, active: true },
        ],
      },
    ]);

    await windowManager.initializeTracking();

    const tracker = windowManager.getWindowTracker(1)!;
    const sorted = [...tracker.tabarr].sort((a, b) => b.order - a.order).map((e) => e.tabId);
    expect(sorted).toEqual([30, 20, 10]);
  });

  it("should not rank a missing inactive tab above existing recent tabs", async () => {
    setMockWindows([
      {
        id: 1,
        tabs: [
          { id: 10, active: true },
          { id: 20, active: false },
          { id: 30, active: false },
        ],
      },
    ]);

    const storedState = {
      trackingState: [
        {
          wid: 1,
          moveok: true,
          tabarr: [
            { tabId: 10, order: 5000 },
            { tabId: 20, order: 1000 },
          ],
        },
      ],
      timestamp: Date.now() - 500,
      version: "3.4.3",
    };
    setMockStorageData({ flstState: storedState });

    await windowManager.initializeTracking();

    const tracker = windowManager.getWindowTracker(1)!;
    const orderOf = (tabId: number) => tracker.tabarr.find((e) => e.tabId === tabId)!.order;
    const sorted = [...tracker.tabarr].sort((a, b) => b.order - a.order).map((e) => e.tabId);

    expect(sorted[0]).toBe(10);
    expect(orderOf(30)).toBeLessThan(orderOf(20));
    expect(sorted[sorted.length - 1]).toBe(30);
  });

  it("should rank a missing active tab as most recent", async () => {
    setMockWindows([
      {
        id: 1,
        tabs: [
          { id: 10, active: false },
          { id: 20, active: true },
        ],
      },
    ]);

    const storedState = {
      trackingState: [
        {
          wid: 1,
          moveok: true,
          tabarr: [{ tabId: 10, order: 5000 }],
        },
      ],
      timestamp: Date.now() - 500,
      version: "3.4.3",
    };
    setMockStorageData({ flstState: storedState });

    await windowManager.initializeTracking();

    const tracker = windowManager.getWindowTracker(1)!;
    const sorted = [...tracker.tabarr].sort((a, b) => b.order - a.order).map((e) => e.tabId);
    expect(sorted[0]).toBe(20);
  });
});
