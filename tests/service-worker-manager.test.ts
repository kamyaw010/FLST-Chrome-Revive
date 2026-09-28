/**
 * Unit tests for ServiceWorkerManager - keepalive, dormancy detection, reconciliation.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { getMockStorageData, resetChromeMock } from "./chrome-mock";
import { storageManager } from "../src/managers/storage-manager";
import { createFreshServiceWorkerManager, createTracker, sleep } from "./test-helpers";

let swManager: ReturnType<typeof createFreshServiceWorkerManager>;

beforeEach(() => {
  resetChromeMock();
  (storageManager as any).saveDebounceTimer = null;
  (storageManager as any).pendingTrackingState = null;
  swManager = createFreshServiceWorkerManager();
});

// ============================================================================
// Keepalive Alarm
// ============================================================================

describe("Keepalive Alarm", () => {
  it("should create alarm on startKeepalive", async () => {
    await swManager.startKeepalive();

    const alarm = await chrome.alarms.get("flst-keepalive");
    expect(alarm).toBeDefined();
    expect(alarm!.periodInMinutes).toBe(0.5);
  });

  it("should mark service worker as active after starting", async () => {
    expect(swManager.isServiceWorkerActive()).toBe(false);

    await swManager.startKeepalive();

    expect(swManager.isServiceWorkerActive()).toBe(true);
  });
});

// ============================================================================
// Dormancy Detection
// ============================================================================

describe("Dormancy Detection via Keepalive Alarm", () => {
  it("should NOT trigger reconciliation when alarm fires within normal period", async () => {
    const reconcileSpy = vi.fn().mockResolvedValue(undefined);
    swManager.setReconciliationCallback(reconcileSpy);
    await swManager.startKeepalive();

    // Simulate a quick alarm fire (well within 35s threshold)
    await swManager.handleKeepaliveAlarm();

    // Wait for potential async reconciliation (250ms delay in triggerReconciliation)
    await new Promise((r) => setTimeout(r, 350));

    expect(reconcileSpy).not.toHaveBeenCalled();
  });

  it("should trigger reconciliation when alarm fire indicates dormancy (>35s)", async () => {
    const reconcileSpy = vi.fn().mockResolvedValue(undefined);
    swManager.setReconciliationCallback(reconcileSpy);
    await swManager.startKeepalive();

    // Simulate dormancy by setting lastActivationTime far in the past
    (swManager as any).lastActivationTime = Date.now() - 40000;

    await swManager.handleKeepaliveAlarm();

    // Wait for the 250ms delay in triggerReconciliation
    await new Promise((r) => setTimeout(r, 350));

    expect(reconcileSpy).toHaveBeenCalledOnce();
  });
});

// ============================================================================
// Reactivation
// ============================================================================

describe("Service Worker Reactivation", () => {
  it("should ensure keepalive alarm exists on reactivation", async () => {
    // Don't start keepalive first - simulate fresh reactivation
    await swManager.handleReactivation();

    const alarm = await chrome.alarms.get("flst-keepalive");
    expect(alarm).toBeDefined();
  });

  it("should trigger reconciliation after long inactivity", async () => {
    const reconcileSpy = vi.fn().mockResolvedValue(undefined);
    swManager.setReconciliationCallback(reconcileSpy);

    // Set last activation far in the past
    (swManager as any).lastActivationTime = Date.now() - 15000;

    await swManager.handleReactivation();

    // Wait for the 250ms delay
    await new Promise((r) => setTimeout(r, 350));

    expect(reconcileSpy).toHaveBeenCalledOnce();
  });

  it("should NOT trigger reconciliation for quick restart (<10s)", async () => {
    const reconcileSpy = vi.fn().mockResolvedValue(undefined);
    swManager.setReconciliationCallback(reconcileSpy);

    // Set last activation very recently
    (swManager as any).lastActivationTime = Date.now() - 2000;

    await swManager.handleReactivation();

    await new Promise((r) => setTimeout(r, 350));

    expect(reconcileSpy).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Suspend
// ============================================================================

describe("Service Worker Suspend", () => {
  it("should mark service worker as inactive on suspend", async () => {
    await swManager.startKeepalive();
    expect(swManager.isServiceWorkerActive()).toBe(true);

    swManager.handleSuspend();

    expect(swManager.isServiceWorkerActive()).toBe(false);
  });

  it("should flush pending tracking state on suspend", async () => {
    await storageManager.saveTrackingState([createTracker(1, [{ id: 10, order: 1000 }])]);

    expect(getMockStorageData().flstState).toBeUndefined();

    swManager.handleSuspend();
    await sleep(10);

    expect(getMockStorageData().flstState.trackingState).toHaveLength(1);
    expect(getMockStorageData().flstState.trackingState[0].tabarr[0].tabId).toBe(10);
  });
});

// ============================================================================
// Suspend Canceled
// ============================================================================

describe("Suspend Canceled", () => {
  it("should re-mark as active and trigger reconciliation on suspend cancel", async () => {
    const reconcileSpy = vi.fn().mockResolvedValue(undefined);
    swManager.setReconciliationCallback(reconcileSpy);

    swManager.handleSuspend();
    expect(swManager.isServiceWorkerActive()).toBe(false);

    await swManager.handleSuspendCanceled();

    await new Promise((r) => setTimeout(r, 350));

    expect(swManager.isServiceWorkerActive()).toBe(true);
    expect(reconcileSpy).toHaveBeenCalledOnce();
  });
});

// ============================================================================
// Status
// ============================================================================

describe("Status Reporting", () => {
  it("should report correct status", async () => {
    const before = swManager.getStatus();
    expect(before.active).toBe(false);
    expect(before.lastActivation).toBe(0);

    await swManager.startKeepalive();

    const after = swManager.getStatus();
    expect(after.active).toBe(true);
    expect(after.lastActivation).toBeGreaterThan(0);
  });
});
