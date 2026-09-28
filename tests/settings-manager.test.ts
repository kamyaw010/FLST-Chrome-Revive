import { describe, it, expect, beforeEach } from "vitest";
import { resetChromeMock } from "./chrome-mock";
import { createFreshSettingsManager } from "./test-helpers";
import { logger } from "../src/utils/logger";

let settingsManager: ReturnType<typeof createFreshSettingsManager>;

beforeEach(async () => {
  resetChromeMock();
  settingsManager = createFreshSettingsManager();
  await settingsManager.initialize();
});

describe("Settings Manager", () => {
  it("should initialize all option defaults", () => {
    expect(settingsManager.getSettings()).toEqual({
      flip: 1,
      ntsel: 1,
      reloc: 1,
      ntord: 0,
      log: false,
    });
  });

  it("should toggle logger without changing behavioral settings", async () => {
    await settingsManager.updateSetting("log", 1, "test");

    expect(Boolean(logger.isLoggingEnabled())).toBe(true);
    expect(settingsManager.getSetting("flip")).toBe(1);
    expect(settingsManager.getSetting("ntsel")).toBe(1);
    expect(settingsManager.getSetting("reloc")).toBe(1);
    expect(settingsManager.getSetting("ntord")).toBe(0);

    await settingsManager.updateSetting("log", 0, "test");
    expect(Boolean(logger.isLoggingEnabled())).toBe(false);
  });

  it("should update ntord without mutating other options", async () => {
    await settingsManager.updateSetting("ntord", 1, "test");

    expect(settingsManager.getSettings()).toMatchObject({
      flip: 1,
      ntsel: 1,
      reloc: 1,
      ntord: 1,
    });
  });
});
