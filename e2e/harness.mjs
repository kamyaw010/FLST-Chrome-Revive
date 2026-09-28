import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT = path.resolve(__dirname, "..");
export const SANDBOX = path.join(PROJECT, ".sandbox");
export const CHROME_EXE =
  process.env.E2E_CHROME_EXE || path.join(SANDBOX, "chrome", "chrome-win64", "chrome.exe");
export const DEFAULT_EXTENSION = path.join(SANDBOX, "extension-local");
export const LOGS_DIR = path.join(SANDBOX, "logs");
export const PROFILES_DIR = path.join(SANDBOX, "profiles");

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(fn, { timeout = 10000, interval = 100, message = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${message}${lastError ? ` (last error: ${lastError.message})` : ""}`);
}

export function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(
    d.getMinutes(),
  )}${pad(d.getSeconds())}`;
}

export function freshProfile(name) {
  const dir = path.join(PROFILES_DIR, `${name}-${timestamp()}-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function launchSandbox({
  extensionDir = DEFAULT_EXTENSION,
  userDataDir,
  extraArgs = [],
  headless = false,
} = {}) {
  if (!fs.existsSync(path.join(extensionDir, "manifest.json"))) {
    throw new Error(`Extension manifest not found in ${extensionDir}`);
  }
  if (!fs.existsSync(CHROME_EXE)) {
    throw new Error(`Chrome for Testing not found at ${CHROME_EXE}`);
  }

  const args = [
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-search-engine-choice-screen",
    "--disable-features=Translate,MediaRouter,OptimizationHints,OptimizationGuideModelDownloading",
    ...extraArgs,
  ];

  const browser = await puppeteer.launch({
    executablePath: CHROME_EXE,
    headless,
    userDataDir,
    args,
    defaultViewport: null,
    protocolTimeout: 30000,
    ignoreDefaultArgs: ["--disable-extensions"],
  });

  return browser;
}

export async function closeSandbox(browser) {
  if (!browser) return;
  const proc = browser.process();
  const pid = proc?.pid;
  try {
    await Promise.race([browser.close(), sleep(8000)]);
  } catch {
    /* ignore */
  }
  if (pid) {
    for (let i = 0; i < 20; i += 1) {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
      await sleep(250);
    }
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  }
}

export function getServiceWorkerTarget(browser) {
  return (
    browser
      .targets()
      .find((t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://")) ?? null
  );
}

export async function getExtensionId(browser, timeout = 20000) {
  const target = await browser.waitForTarget(
    (t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"),
    { timeout },
  );
  const match = /^chrome-extension:\/\/([^/]+)\//.exec(target.url());
  if (!match) throw new Error(`Cannot parse extension id from ${target.url()}`);
  return match[1];
}

export async function wakeServiceWorker(browser) {
  const page = await browser.newPage();
  await page.close().catch(() => {});
  await sleep(500);
}

export async function evalSw(browser, fn, ...args) {
  const expression = `(${fn.toString()})(${args.map((arg) => JSON.stringify(arg)).join(", ")})`;
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const target = getServiceWorkerTarget(browser);
    if (target) {
      let session = null;
      try {
        session = await target.createCDPSession();
        await session.send("Runtime.runIfWaitingForDebugger").catch(() => {});
        const result = await session.send("Runtime.evaluate", {
          expression,
          awaitPromise: true,
          returnByValue: true,
        });
        if (result.exceptionDetails) {
          const description =
            result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
          throw new Error(description);
        }
        return result.result?.value;
      } catch (error) {
        lastError = error;
      } finally {
        await session?.detach().catch(() => {});
      }
    }
    if (attempt < 3) {
      await wakeServiceWorker(browser);
    }
  }
  throw new Error(`Service worker eval failed after retries: ${lastError?.message ?? "no worker target"}`);
}

export class SwLogCollector {
  constructor(browser, logFile) {
    this.browser = browser;
    this.logFile = logFile;
    this.currentTarget = null;
    this.session = null;
    this.timer = null;
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
  }

  start() {
    this.timer = setInterval(() => this.attachIfNeeded(), 500);
    this.attachIfNeeded();
  }

  setBrowser(browser) {
    this.browser = browser;
    this.currentTarget = null;
    this.session = null;
  }

  async attachIfNeeded() {
    const target = getServiceWorkerTarget(this.browser);
    if (!target) {
      this.currentTarget = null;
      return;
    }
    if (target === this.currentTarget) {
      try {
        const worker = await target.worker();
        if (worker) return;
      } catch {
        /* worker stopped */
      }
      this.currentTarget = null;
    }
    this.currentTarget = target;
    try {
      const session = await target.createCDPSession();
      await session.send("Runtime.enable");
      await session.send("Runtime.runIfWaitingForDebugger").catch(() => {});
      session.on("Runtime.consoleAPICalled", (event) => {
        const text = event.args.map(formatRemoteObject).join(" ");
        this.write(`[console.${event.type}] ${text}`);
      });
      session.on("Runtime.exceptionThrown", (event) => {
        const details = event.exceptionDetails;
        const description = details?.exception?.description ?? details?.text ?? "unknown error";
        this.write(`[exception] ${description}`);
      });
      this.session = session;
      this.write("[harness] attached to service worker");
    } catch {
      this.currentTarget = null;
    }
  }

  write(line) {
    const stamp = new Date().toISOString();
    fs.appendFileSync(this.logFile, `${stamp} ${line}\n`);
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.session) {
      try {
        await this.session.detach();
      } catch {
        /* target already closed */
      }
      this.session = null;
    }
  }
}

function formatRemoteObject(remote) {
  if (remote.value !== undefined) {
    return typeof remote.value === "string" ? remote.value : JSON.stringify(remote.value);
  }
  if (remote.description) return remote.description;
  if (remote.preview?.properties) {
    return JSON.stringify(
      Object.fromEntries(remote.preview.properties.map((p) => [p.name, p.value ?? p.type])),
    );
  }
  return remote.type;
}

export async function waitForInit(browser, timeout = 30000) {
  return waitFor(
    async () => {
      const status = await evalSw(browser, () => {
        const debug = globalThis.FLST_DEBUG;
        return debug ? debug.getStatus() : null;
      });
      return status?.initialized ? status : null;
    },
    { timeout, message: "extension initialization" },
  );
}

export async function getExtensionStatus(browser) {
  return evalSw(browser, () => globalThis.FLST_DEBUG?.getStatus?.() ?? null);
}

export async function getStorageSnapshot(browser) {
  return evalSw(browser, () => chrome.storage.local.get(null));
}

export async function getTabs(browser) {
  return evalSw(browser, () => chrome.tabs.query({}));
}

export async function getActiveTab(browser) {
  return evalSw(browser, async () => {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tabs[0] ?? null;
  });
}

export async function createTab(
  browser,
  { url = "about:blank", active = false, windowId, index, openerTabId } = {},
) {
  return evalSw(
    browser,
    async (options) => {
      const properties = { url: options.url, active: options.active };
      if (options.windowId != null) properties.windowId = options.windowId;
      if (options.index != null) properties.index = options.index;
      if (options.openerTabId != null) properties.openerTabId = options.openerTabId;
      const tab = await chrome.tabs.create(properties);
      return { id: tab.id, index: tab.index, windowId: tab.windowId };
    },
    { url, active, windowId, index, openerTabId },
  );
}

export async function activateTab(browser, tabId) {
  await evalSw(browser, (id) => chrome.tabs.update(id, { active: true }), tabId);
}

export async function closeTab(browser, tabId) {
  await evalSw(browser, (id) => chrome.tabs.remove(id), tabId);
}

export async function getMruForWindow(browser, windowId) {
  const snapshot = await getStorageSnapshot(browser);
  const trackers = snapshot?.flstState?.trackingState ?? [];
  const tracker = trackers.find((t) => t.wid === windowId);
  if (!tracker) return null;
  return [...tracker.tabarr].sort((a, b) => b.order - a.order);
}

export async function getCurrentWindowId(browser) {
  return evalSw(browser, async () => {
    const tab = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    return tab?.windowId ?? null;
  });
}

export async function getTabsInWindow(browser, windowId) {
  return evalSw(browser, (wid) => chrome.tabs.query({ windowId: wid }), windowId);
}

export async function getActiveTabInWindow(browser, windowId) {
  const tabs = await getTabsInWindow(browser, windowId);
  return tabs.find((tab) => tab.active) ?? null;
}

export async function waitForActiveTabInWindow(browser, windowId, expectedTabId, timeout = 5000) {
  const result = await waitFor(
    async () => {
      const active = await getActiveTabInWindow(browser, windowId);
      return active?.id === expectedTabId ? active.id : null;
    },
    { timeout, interval: 150, message: `active tab ${expectedTabId} in window ${windowId}` },
  ).catch(() => null);
  return result;
}

export async function waitForActiveTab(browser, expectedTabId, timeout = 5000) {
  return waitFor(
    async () => {
      const active = await getActiveTab(browser);
      return active?.id === expectedTabId ? active : null;
    },
    { timeout, interval: 150, message: `active tab ${expectedTabId}` },
  ).catch(() => null);
}

export async function waitForMruOrder(browser, windowId, expectedTop, timeout = 6000) {
  return waitFor(
    async () => {
      const mru = await getMruForWindow(browser, windowId);
      if (!mru) return null;
      const top = mru.slice(0, expectedTop.length).map((entry) => entry.tabId);
      return JSON.stringify(top) === JSON.stringify(expectedTop) ? mru : null;
    },
    { timeout, interval: 250, message: `MRU order ${JSON.stringify(expectedTop)}` },
  ).catch(() => null);
}

export async function openPopupPage(browser, extensionId, windowId) {
  const popupUrl = `chrome-extension://${extensionId}/popup.html`;
  const existing = await evalSw(
    browser,
    async (url) => (await chrome.tabs.query({}))
      .filter((t) => t.url === url)
      .map((t) => t.id),
    popupUrl,
  );
  for (const id of existing) {
    await closeTab(browser, id);
  }
  const created = await createTab(browser, { url: popupUrl, active: false, windowId });
  const target = await browser.waitForTarget((t) => t.url() === popupUrl, { timeout: 15000 });
  const page = await target.page();
  if (!page) throw new Error("Could not obtain popup page handle");
  await page.waitForSelector("#flipNow", { timeout: 10000 });
  return { page, tabId: created.id };
}

export async function setSettings(browser, popupPage, settings) {
  await popupPage.evaluate(async (values) => {
    await chrome.storage.local.set(values);
    for (const [option, value] of Object.entries(values)) {
      await chrome.runtime.sendMessage({
        type: "settingUpdate",
        data: { source: "harness", option, value },
      });
    }
  }, settings);
}

export async function clickPopupFlip(browser, extensionId, popupPage) {
  if (popupPage.isClosed()) {
    throw new Error("popup page is closed - reopen before clicking flip");
  }
  await popupPage.evaluate(() => {
    const button = document.getElementById("flipNow");
    if (!button) throw new Error("flip button missing");
    button.click();
  });
  await sleep(300);
}

export async function triggerPopupFlipAction(popupPage) {
  await popupPage.evaluate(() => {
    const button = document.getElementById("flipNow");
    if (!button) throw new Error("flip button missing");
    button.click();
  });
  await sleep(300);
}

export async function getCommands(browser) {
  return evalSw(browser, () => chrome.commands.getAll());
}

function shortcutToSendKeys(shortcut) {
  if (!shortcut) return null;
  const parts = shortcut.split("+").map((part) => part.trim().toLowerCase());
  const mapped = parts.map((part) => {
    if (part === "control") return "ctrl";
    return part;
  });
  return mapped.join("+");
}

export function sendKeysToWindow(chromePid, combination) {
  const scriptPath = path.join(__dirname, "send-keys.ps1");
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-ProcessId", String(chromePid), "-Combination", combination],
    { encoding: "utf8", timeout: 20000 },
  );
  return {
    ok: result.status === 0,
    status: result.status,
    output: (result.stdout ?? "").trim(),
    error: (result.stderr ?? "").trim(),
  };
}

export async function sendKeysToSandbox(browser, keys) {
  const pid = browser.process()?.pid;
  if (!pid) throw new Error("No browser pid");
  const result = sendKeysToWindow(pid, keys);
  return { keys, ...result };
}

export async function triggerFlipShortcut(browser, commandName = "flip-current-tab") {
  const commands = await getCommands(browser);
  const command = commands.find((c) => c.name === commandName);
  if (!command?.shortcut) {
    throw new Error(`Command ${commandName} has no shortcut assigned`);
  }
  const keys = shortcutToSendKeys(command.shortcut);
  const result = await sendKeysToSandbox(browser, keys);
  return { shortcut: command.shortcut, ...result };
}

export async function flipAndWait(browser, expectedTabId, { retries = 3, perTryTimeout = 2000 } = {}) {
  let last = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const before = (await getActiveTab(browser))?.id ?? null;
    let delivered;
    try {
      delivered = { ok: false, ...(await triggerFlipShortcut(browser)) };
    } catch (error) {
      delivered = { ok: false, error: error.message };
    }
    const matched = await waitForActiveTab(browser, expectedTabId, perTryTimeout);
    if (matched) {
      return { ok: true, attempts: attempt, before, delivered, after: matched.id };
    }
    last = { ok: false, attempts: attempt, before, delivered, after: (await getActiveTab(browser))?.id ?? null };
  }
  return last;
}

export async function stopAllServiceWorkers(browser) {
  const session = await browser.target().createCDPSession();
  try {
    await session.send("ServiceWorker.stopAllWorkers");
  } finally {
    await session.detach().catch(() => {});
  }
}

export async function openServiceWorkerInternals(browser) {
  const page = await browser.newPage();
  await page.goto("chrome://serviceworker-internals/", {
    waitUntil: "domcontentloaded",
    timeout: 15000,
  });
  await sleep(800);
  return page;
}

export async function stopServiceWorkerViaInternals(browser, internalsPage) {
  const clicked = await internalsPage.evaluate(() => {
    const button = document.querySelector('cr-button[data-command="stop"]');
    if (!button) return false;
    button.click();
    return true;
  });
  if (!clicked) {
    throw new Error("Stop button not found on serviceworker-internals page");
  }
  await waitFor(
    async () => (await getServiceWorkerRunningStatus(internalsPage)) === "STOPPED",
    { timeout: 8000, message: "service worker to stop" },
  );
}

export async function getServiceWorkerRunningStatus(internalsPage) {
  return internalsPage.evaluate(() => {
    const match = document.body.innerText.match(/Running Status: (\w+)/);
    return match ? match[1] : null;
  });
}

export class Checks {
  constructor() {
    this.items = [];
  }

  check(name, pass, detail = "") {
    this.items.push({ name, pass: Boolean(pass), detail });
    const icon = pass ? "PASS" : "FAIL";
    console.log(`    [${icon}] ${name}${detail ? ` :: ${detail}` : ""}`);
    return Boolean(pass);
  }

  equals(name, actual, expected) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    return this.check(name, pass, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  }

  notEqual(name, actual, expected) {
    const pass = JSON.stringify(actual) !== JSON.stringify(expected);
    return this.check(name, pass, `actual=${JSON.stringify(actual)} unexpected=${JSON.stringify(expected)}`);
  }

  summary() {
    const failed = this.items.filter((item) => !item.pass);
    return { total: this.items.length, failed: failed.length, failedItems: failed };
  }
}
