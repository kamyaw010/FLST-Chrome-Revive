import type { TabMRUEntry } from "../../types.js";

export function addTabToMRU(
  tabarr: TabMRUEntry[],
  tabId: number,
  position: "first" | "last" = "last",
  order: number = Date.now(),
): void {
  const entry: TabMRUEntry = { tabId, order };

  if (position === "first") {
    tabarr.unshift(entry);
  } else {
    tabarr.push(entry);
  }
}

export function getLeastRecentOrder(tabarr: TabMRUEntry[]): number {
  if (tabarr.length === 0) return Date.now();

  let minOrder = tabarr[0].order;
  for (const entry of tabarr) {
    if (entry.order < minOrder) {
      minOrder = entry.order;
    }
  }

  return minOrder - 1;
}

export function removeTabFromMRU(tabarr: TabMRUEntry[], tabId: number): number {
  const index = tabarr.findIndex((entry) => entry.tabId === tabId);
  if (index !== -1) {
    tabarr.splice(index, 1);
  }
  return index;
}

export function updateTabTimestamp(tabarr: TabMRUEntry[], tabId: number): number | null {
  const entry = tabarr.find((item) => item.tabId === tabId);
  if (!entry) {
    return null;
  }

  entry.order = Date.now();
  return entry.order;
}

export function getMostRecentTabId(tabarr: TabMRUEntry[]): number | null {
  if (tabarr.length === 0) return null;

  let maxTimestamp = 0;
  let mostRecentTabId: number | null = null;

  for (const entry of tabarr) {
    if (entry.order > maxTimestamp) {
      maxTimestamp = entry.order;
      mostRecentTabId = entry.tabId;
    }
  }

  return mostRecentTabId;
}

export function getMostRecentTabExcluding(
  tabarr: TabMRUEntry[],
  excludeTabId: number,
): number | null {
  if (tabarr.length === 0) return null;

  let maxTimestamp = 0;
  let mostRecentTabId: number | null = null;

  for (const entry of tabarr) {
    if (entry.tabId !== excludeTabId && entry.order > maxTimestamp) {
      maxTimestamp = entry.order;
      mostRecentTabId = entry.tabId;
    }
  }

  return mostRecentTabId;
}

export function findTabInMRU(
  tabarr: TabMRUEntry[],
  tabId: number,
): { entry: TabMRUEntry; index: number } | null {
  const index = tabarr.findIndex((entry) => entry.tabId === tabId);
  if (index === -1) return null;
  return { entry: tabarr[index], index };
}
