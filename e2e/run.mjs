import fs from "node:fs";
import path from "node:path";
import {
  Checks,
  DEFAULT_EXTENSION,
  LOGS_DIR,
  PROJECT,
  SwLogCollector,
  closeSandbox,
  freshProfile,
  getExtensionId,
  launchSandbox,
  timestamp,
  waitForInit,
} from "./harness.mjs";
import { scenarios } from "./scenarios.mjs";

const requested = process.argv.slice(2);
const names = requested.length ? requested : Object.keys(scenarios);
const SCENARIO_TIMEOUT = Number(process.env.SANDBOX_SCENARIO_TIMEOUT ?? 300000);

function syncExtensionFromDist() {
  const distDir = path.join(PROJECT, "dist");
  if (!fs.existsSync(path.join(distDir, "manifest.json"))) {
    console.error("dist/manifest.json not found. Run `npm run build:dev` first.");
    process.exit(1);
  }
  fs.rmSync(DEFAULT_EXTENSION, { recursive: true, force: true });
  fs.cpSync(distDir, DEFAULT_EXTENSION, { recursive: true });
  console.log(`extension synced: ${DEFAULT_EXTENSION}`);
}

syncExtensionFromDist();

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

const results = [];

for (const name of names) {
  if (!scenarios[name]) {
    console.log(`Unknown scenario: ${name}`);
    process.exitCode = 1;
    continue;
  }

  const profile = freshProfile(name);
  const logFile = path.join(LOGS_DIR, `${name}-${timestamp()}.log`);
  console.log(`\n=== scenario: ${name} ===`);
  console.log(`profile: ${profile}`);
  console.log(`log: ${logFile}`);

  const checks = new Checks();
  let browser = null;
  let collector = null;

  try {
    browser = await launchSandbox({ userDataDir: profile });
    collector = new SwLogCollector(browser, logFile);
    collector.start();

    const extensionId = await withTimeout(getExtensionId(browser), 30000, "extension load");
    collector.write(`[harness] extension id: ${extensionId}`);
    await withTimeout(waitForInit(browser), 30000, "extension init");

    const ctx = {
      browser,
      profileDir: profile,
      collector,
      extensionId,
      checks,
      log: (message) => collector.write(`[harness] ${message}`),
    };

    await withTimeout(scenarios[name](ctx), SCENARIO_TIMEOUT, `scenario ${name}`);
  } catch (error) {
    checks.check("scenario completed without exception", false, error.message);
    collector?.write(`[harness] scenario error: ${error.stack ?? error.message}`);
    console.error(error);
  } finally {
    await collector?.stop();
    await closeSandbox(browser);
  }

  const summary = checks.summary();
  results.push({ name, ...summary });
  console.log(`--- ${name}: ${summary.total - summary.failed}/${summary.total} passed ---`);
}

console.log("\n=== summary ===");
let failedTotal = 0;
for (const result of results) {
  const status = result.failed === 0 ? "PASS" : "FAIL";
  console.log(`${status}  ${result.name}: ${result.total - result.failed}/${result.total}`);
  failedTotal += result.failed;
}
if (failedTotal > 0) {
  process.exitCode = 1;
}
