// Type definitions for FLST Chrome extension

export interface TabMRUEntry {
  tabId: number;
  order: number; // Timestamp (Date.now()) for ordering
}

export interface TabTracker {
  tabarr: TabMRUEntry[];
  wid: number;
  moveok: boolean;
}

export interface StoredTrackingState {
  trackingState: TabTracker[];
  timestamp: number;
  version: string;
}

export interface ExtensionState {
  log: boolean;
  logstrs: string[];
  flip: number;
  ntsel: number; // New tab selection: 1 = select new tab, 0 = chrome standard
  reloc: number;
  track: TabTracker[];
  skip?: string | null;
}

export interface Extension {
  state: ExtensionState;
}

export interface TabInfo {
  tabarr: TabMRUEntry[] | null;
  tabloc: number;
}

export interface SettingUpdateMessage {
  type: "settingUpdate";
  data: {
    source: string;
    option: string;
    value: number;
  };
}

export interface SafeTabMoveCallback {
  (result: any, error: string | null): void;
}

// Skip activation reasons
export enum SkipActivationReason {
  NEW_TAB = "NewTab",
  ATTACH = "Attach",
  DETACH = "Detach",
  TAB_FLIP = "TabFlip",
  CLOSE_TAB = "CloseTab",
  CLOSE_TAB_CORRECTION = "CloseTab-Correction",
}

export interface SkipActivationInfo {
  reason: SkipActivationReason;
  expectedTabId?: number;
}

export interface StorageData {
  [key: string]: any;
  flip?: number;
  reloc?: number;
  trackingState?: TabTracker[];
}
