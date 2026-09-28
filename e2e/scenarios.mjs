import {
  activateTab,
  closeSandbox,
  closeTab,
  createTab,
  evalSw,
  flipAndWait,
  getActiveTab,
  getActiveTabInWindow,
  getExtensionId,
  getExtensionStatus,
  getMruForWindow,
  getServiceWorkerRunningStatus,
  getTabs,
  getTabsInWindow,
  launchSandbox,
  openPopupPage,
  openServiceWorkerInternals,
  setSettings,
  sendKeysToSandbox,
  sleep,
  stopServiceWorkerViaInternals,
  triggerFlipShortcut,
  triggerPopupFlipAction,
  waitForActiveTab,
  waitForActiveTabInWindow,
  waitForInit,
  waitForMruOrder,
} from "./harness.mjs";

async function prepare(ctx, settings) {
  const { browser } = ctx;
  const popup = await openPopupPage(browser, ctx.extensionId);
  await setSettings(browser, popup.page, settings);
  await sleep(700);
  return popup;
}

async function closePopup(ctx, popup) {
  await closeTab(ctx.browser, popup.tabId).catch(() => {});
  await sleep(400);
}

async function mainWindowId(ctx) {
  const tabs = await getTabs(ctx.browser);
  const active = tabs.find((t) => t.active);
  return active?.windowId ?? tabs[0]?.windowId ?? null;
}

function mruIds(mru, count) {
  return (mru ?? []).slice(0, count).map((entry) => entry.tabId);
}

async function setupTabs(ctx, count) {
  const windowId = await mainWindowId(ctx);
  const tabs = [];
  for (let i = 0; i < count; i += 1) {
    tabs.push(await createTab(ctx.browser, { windowId }));
  }
  await sleep(1000);
  for (const tab of tabs) {
    await activateTab(ctx.browser, tab.id);
    await sleep(350);
  }
  return { windowId, tabs };
}

export async function smoke(ctx) {
  const { browser, checks } = ctx;
  const status = await getExtensionStatus(browser);
  checks.check("extension initialized", status?.initialized === true, JSON.stringify(status));

  const popup = await prepare(ctx, { flip: 1, ntsel: 0, reloc: 0, ntord: 0, log: true });
  await closePopup(ctx, popup);

  const { windowId, tabs } = await setupTabs(ctx, 3);
  const [A, B, C] = tabs;

  const mruAfterSwitch = await waitForMruOrder(browser, windowId, [C.id, B.id, A.id]);
  ctx.log(`MRU after A->B->C: ${JSON.stringify(mruAfterSwitch)}`);
  checks.equals("MRU order is C,B,A", mruIds(mruAfterSwitch, 3), [C.id, B.id, A.id]);

  await closeTab(browser, C.id);
  const activeAfterClose = await waitForActiveTab(browser, B.id);
  checks.equals("closing C activates B (MRU)", activeAfterClose?.id, B.id);

  const flip1 = await flipAndWait(browser, A.id);
  ctx.log(`flip 1: ${JSON.stringify(flip1)}`);
  checks.check("Alt+N delivered", flip1.delivered?.ok === true, JSON.stringify(flip1.delivered));
  checks.equals("Alt+N activates A", flip1.after, A.id);

  const flip2 = await flipAndWait(browser, B.id);
  ctx.log(`flip 2: ${JSON.stringify(flip2)}`);
  checks.equals("second Alt+N activates B", flip2.after, B.id);
}

export async function closeMru(ctx) {
  const { browser, checks } = ctx;
  await prepare(ctx, { flip: 1, ntsel: 0, reloc: 0, ntord: 0, log: true });

  const { windowId, tabs } = await setupTabs(ctx, 4);
  const [A, B, C, D] = tabs;
  await waitForMruOrder(browser, windowId, [D.id, C.id, B.id, A.id]);

  await closeTab(browser, D.id);
  const activeAfterD = await waitForActiveTab(browser, C.id);
  checks.equals("close D -> activate C", activeAfterD?.id, C.id);

  await closeTab(browser, C.id);
  const activeAfterC = await waitForActiveTab(browser, B.id);
  checks.equals("close C -> activate B", activeAfterC?.id, B.id);

  await closeTab(browser, B.id);
  const activeAfterB = await waitForActiveTab(browser, A.id);
  checks.equals("close B -> activate A", activeAfterB?.id, A.id);
}

export async function flip(ctx) {
  const { browser, checks } = ctx;
  await prepare(ctx, { flip: 1, ntsel: 0, reloc: 0, ntord: 0, log: true });

  const { windowId, tabs } = await setupTabs(ctx, 3);
  const [A, B, C] = tabs;
  await waitForMruOrder(browser, windowId, [C.id, B.id, A.id]);

  const flip1 = await flipAndWait(browser, B.id);
  checks.equals("flip 1 -> B", flip1.after, B.id);

  const flip2 = await flipAndWait(browser, C.id);
  checks.equals("flip 2 -> C", flip2.after, C.id);

  const flip3 = await flipAndWait(browser, B.id);
  checks.equals("flip 3 -> B", flip3.after, B.id);
}

export async function backgroundTabMru(ctx) {
  const { browser, checks } = ctx;
  await prepare(ctx, { flip: 1, ntsel: 0, reloc: 0, ntord: 0, log: true });

  const { windowId, tabs } = await setupTabs(ctx, 3);
  const [A, B, C] = tabs;
  await waitForMruOrder(browser, windowId, [C.id, B.id, A.id]);

  const D = await createTab(browser, { windowId, active: false });
  await sleep(1200);
  const mruAfterBackground = await getMruForWindow(browser, windowId);
  ctx.log(`MRU after background tab D: ${JSON.stringify(mruAfterBackground)}`);
  checks.check(
    "background tab D is not ranked most recent",
    mruAfterBackground?.[0]?.tabId !== D.id,
    `top=${mruAfterBackground?.[0]?.tabId} D=${D.id}`,
  );
  checks.equals("MRU top3 still C,B,A", mruIds(mruAfterBackground, 3), [C.id, B.id, A.id]);

  const flipResult = await flipAndWait(browser, B.id);
  ctx.log(`flip after background tab: ${JSON.stringify(flipResult)}`);
  checks.check("Alt+N delivered", flipResult.delivered?.ok === true, JSON.stringify(flipResult.delivered));
  checks.equals("Alt+N from C goes to B", flipResult.after, B.id);

  await activateTab(browser, C.id);
  await sleep(500);
  await closeTab(browser, C.id);
  const activeAfterClose = await waitForActiveTab(browser, B.id, 6000);
  checks.equals("closing C activates B (not background tab D)", activeAfterClose?.id, B.id);
}

export async function dormancy(ctx) {
  const { browser, checks } = ctx;
  const popup = await prepare(ctx, { flip: 1, ntsel: 0, reloc: 0, ntord: 0, log: true });
  await closePopup(ctx, popup);

  const { windowId, tabs } = await setupTabs(ctx, 3);
  const [A, B, C] = tabs;
  await waitForMruOrder(browser, windowId, [C.id, B.id, A.id]);

  const allTabs = await getTabs(browser);
  const aIndex = allTabs.find((t) => t.id === A.id)?.index ?? -1;
  ctx.log(`tab A index: ${aIndex} (ctrl+${aIndex + 1} selects it)`);
  if (aIndex < 0) {
    checks.check("can locate tab A", false, `index=${aIndex}`);
    return;
  }

  const internals = await openServiceWorkerInternals(browser);
  await sleep(800);
  await stopServiceWorkerViaInternals(browser, internals);
  const stoppedStatus = await getServiceWorkerRunningStatus(internals);
  checks.equals("service worker stopped", stoppedStatus, "STOPPED");
  await sleep(500);

  const wake = await sendKeysToSandbox(browser, `ctrl+${aIndex + 1}`);
  ctx.log(`wake keys result: ${JSON.stringify(wake)}`);
  await waitForInit(browser, 20000);
  const mruAfterWake = await waitForMruOrder(browser, windowId, [A.id]);
  checks.equals("MRU records activation after SW restart", mruIds(mruAfterWake, 1), [A.id]);

  const internalsTabId = await evalSw(
    browser,
    async () =>
      (await chrome.tabs.query({})).find((tab) => tab.url === "chrome://serviceworker-internals/")?.id ?? null,
  );
  if (internalsTabId) await closeTab(browser, internalsTabId).catch(() => {});
  await sleep(400);

  await activateTab(browser, C.id);
  await sleep(400);
  await closeTab(browser, C.id);
  const active = await waitForActiveTab(browser, A.id, 8000);
  checks.equals("close after dormancy -> A", active?.id, A.id);
}

export async function backgroundCloseHijack(ctx) {
  const { browser, checks } = ctx;
  const popup = await prepare(ctx, { flip: 1, ntsel: 0, reloc: 0, ntord: 0, log: true });
  await closePopup(ctx, popup);

  const { windowId, tabs } = await setupTabs(ctx, 3);
  const [A, B, C] = tabs;
  await waitForMruOrder(browser, windowId, [C.id, B.id, A.id]);

  const D = await createTab(browser, { windowId, active: false });
  await sleep(1000);
  ctx.log(`background tab D created: ${D.id}`);

  await closeTab(browser, B.id);
  await sleep(1000);
  ctx.log("closed background tab B while C was active");

  await activateTab(browser, A.id);
  await sleep(1000);
  const active = await getActiveTab(browser);
  ctx.log(`active after manually activating A: ${active?.id}`);
  checks.equals("manual activation is not hijacked to background tab", active?.id, A.id);
}

export async function newtabActiveTracking(ctx) {
  const { browser, checks } = ctx;
  const popup = await prepare(ctx, { flip: 1, ntsel: 1, reloc: 0, ntord: 0, log: true });
  await closePopup(ctx, popup);

  const { windowId, tabs } = await setupTabs(ctx, 2);
  const [A, B] = tabs;
  await waitForMruOrder(browser, windowId, [B.id, A.id]);

  const N = await evalSw(
    browser,
    async () => {
      const tab = await chrome.tabs.create({ active: true });
      return { id: tab.id };
    },
  );
  await sleep(1200);
  ctx.log(`active new tab N created: ${N.id}`);

  await activateTab(browser, A.id);
  await sleep(1000);
  const mru = await getMruForWindow(browser, windowId);
  ctx.log(`MRU after activating A: ${JSON.stringify(mru)}`);
  checks.equals("activation after active new tab updates MRU", mru?.[0]?.tabId, A.id);

  const active = await getActiveTab(browser);
  checks.equals("active tab is A", active?.id, A.id);
}

export async function restart(ctx) {
  const { checks, log } = ctx;
  let browser = ctx.browser;

  const popup = await prepare(ctx, { flip: 1, ntsel: 0, reloc: 0, ntord: 0, log: true });
  await closePopup(ctx, popup);

  const windowId = await mainWindowId(ctx);
  const A = await createTab(browser, { windowId, url: "about:blank#A" });
  const B = await createTab(browser, { windowId, url: "about:blank#B" });
  const C = await createTab(browser, { windowId, url: "about:blank#C" });
  await sleep(1000);
  await activateTab(browser, A.id);
  await sleep(300);
  await activateTab(browser, B.id);
  await sleep(300);
  await activateTab(browser, C.id);
  await waitForMruOrder(browser, windowId, [C.id, B.id, A.id]);
  log(`prepared A=${A.id} B=${B.id} C=${C.id} (MRU C,B,A), restarting browser`);

  await closeSandbox(browser);
  const restarted = await launchSandbox({
    userDataDir: ctx.profileDir,
    extraArgs: ["--restore-last-session"],
  });
  ctx.browser = restarted;
  ctx.collector.setBrowser(restarted);
  browser = restarted;

  await getExtensionId(browser);
  await waitForInit(browser, 30000);
  await sleep(2000);

  const tabs = await getTabs(browser);
  log(
    `tabs after restart: ${JSON.stringify(
      tabs.map((t) => ({ id: t.id, url: t.url, active: t.active })),
    )}`,
  );
  const byFragment = (fragment) =>
    tabs.find((tab) => (tab.url ?? "").toLowerCase().endsWith(`#${fragment}`));
  const ra = byFragment("a");
  const rb = byFragment("b");
  const rc = byFragment("c");
  checks.check("tab A restored", Boolean(ra), `id=${ra?.id}`);
  checks.check("tab B restored", Boolean(rb), `id=${rb?.id}`);
  checks.check("tab C restored", Boolean(rc), `id=${rc?.id}`);
  if (!ra || !rb || !rc) return;

  const wanted = new Set([ra.id, rb.id, rc.id]);
  for (const extra of tabs.filter((tab) => !wanted.has(tab.id))) {
    await closeTab(browser, extra.id).catch(() => {});
    await sleep(300);
  }
  await sleep(500);

  await activateTab(browser, rc.id);
  await sleep(600);
  const activeAfterRestore = await getActiveTab(browser);
  checks.equals("C is active after restart", activeAfterRestore?.id, rc.id);

  const flip1 = await flipAndWait(browser, rb.id);
  log(`flip after restart: ${JSON.stringify(flip1)}`);
  checks.equals("Alt+N after restart goes to B", flip1.after, rb.id);

  const flip2 = await flipAndWait(browser, rc.id);
  checks.equals("second Alt+N after restart goes to C", flip2.after, rc.id);

  await closeTab(browser, rc.id);
  const afterClose = await waitForActiveTab(browser, rb.id, 6000);
  checks.equals("close after restart -> B", afterClose?.id, rb.id);
}

export async function multiWindow(ctx) {
  const { browser, checks } = ctx;
  const popup = await prepare(ctx, { flip: 1, ntsel: 0, reloc: 0, ntord: 0, log: true });
  await closePopup(ctx, popup);

  const window1 = await mainWindowId(ctx);
  const A = await createTab(browser, { windowId: window1 });
  const B = await createTab(browser, { windowId: window1 });
  await sleep(800);
  await activateTab(browser, A.id);
  await sleep(300);
  await activateTab(browser, B.id);
  await sleep(500);

  const second = await evalSw(browser, async () => {
    const win = await chrome.windows.create({ url: "about:blank", focused: true });
    return { id: win.id };
  });
  await sleep(1200);
  const secondTabs = await getTabsInWindow(browser, second.id);
  const W = secondTabs[0];
  const D = await createTab(browser, { windowId: second.id });
  const E = await createTab(browser, { windowId: second.id });
  await sleep(800);
  await activateTab(browser, D.id);
  await sleep(300);
  await activateTab(browser, E.id);
  await sleep(500);
  await waitForMruOrder(browser, second.id, [E.id, D.id, W.id]);

  const popupUrl = `chrome-extension://${ctx.extensionId}/popup.html`;
  const popupTab = await createTab(browser, { url: popupUrl, active: false, windowId: second.id });
  ctx.log(`popup tab in second window: ${popupTab.id}`);
  const target = await browser.waitForTarget((t) => t.url() === popupUrl, { timeout: 15000 });
  const page = await target.page();
  if (!page) throw new Error("could not get popup page in second window");
  await page.waitForSelector("#flipNow", { timeout: 10000 });
  await page.evaluate(() => document.getElementById("flipNow").click());

  const activeAfterFlip = await waitForActiveTabInWindow(browser, second.id, D.id);
  checks.equals("flip in second window -> D", activeAfterFlip, D.id);

  const mainMru = await getMruForWindow(browser, window1);
  checks.equals("main window MRU keeps B,A", mruIds(mainMru, 2), [B.id, A.id]);

  await closeTab(browser, D.id);
  const afterClose = await waitForActiveTabInWindow(browser, second.id, E.id, 6000);
  checks.equals("close in second window -> E", afterClose, E.id);
}

import http from "node:http";

async function startLinkServer() {
  const server = http.createServer((req, res) => {
    if ((req.url ?? "").startsWith("/links")) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<!doctype html><html><body>" +
          '<a id="l1" href="/target#l1" target="_blank">l1</a> ' +
          '<a id="l2" href="/target#l2" target="_blank">l2</a> ' +
          '<a id="b1" href="/target#b1" target="_blank">b1</a> ' +
          '<a id="b2" href="/target#b2" target="_blank">b2</a>' +
          "</body></html>",
      );
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<title>target</title>ok");
  });
  const port = await new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server.address().port)),
  );
  return { server, base: `http://127.0.0.1:${port}` };
}

function tabByFragment(tabs, fragment) {
  return tabs.find((tab) => (tab.url ?? "").toLowerCase().includes(`#${fragment}`)) ?? null;
}

async function puppeteerPageForUrl(browser, urlPrefix) {
  const target = await browser.waitForTarget((t) => t.url().startsWith(urlPrefix), {
    timeout: 15000,
  });
  return target.page();
}

export async function htmlLinksForeground(ctx) {
  const { browser, checks } = ctx;
  const popup = await prepare(ctx, { flip: 1, ntsel: 0, reloc: 1, ntord: 0, log: true });
  await closePopup(ctx, popup);

  const { server, base } = await startLinkServer();
  try {
    const windowId = await mainWindowId(ctx);
    const A = await createTab(browser, { windowId });
    const B = await createTab(browser, { windowId });
    await sleep(600);
    await activateTab(browser, A.id);
    await sleep(250);
    await activateTab(browser, B.id);
    await sleep(300);

    const pageTab = await createTab(browser, { windowId, url: `${base}/links`, active: true });
    await sleep(900);
    const page = await puppeteerPageForUrl(browser, `${base}/links`);
    if (!page) {
      checks.check("link page loaded", false, "no puppeteer page");
      return;
    }
    await page.waitForSelector("#l1");
    checks.check("link page loaded", true, `tab=${pageTab.id}`);

    await page.click("#l1", { noWaitAfter: true });
    await sleep(1200);
    const T1 = tabByFragment(await getTabs(browser), "l1");
    checks.check("foreground link 1 opened a new tab", Boolean(T1), `id=${T1?.id}`);
    if (!T1) return;
    const activeAfterT1 = await getActiveTab(browser);
    checks.equals("foreground link 1 tab becomes active", activeAfterT1?.id, T1.id);

    // The user returns to the page tab before clicking the second link
    await activateTab(browser, pageTab.id);
    await sleep(700);
    await page.click("#l2", { noWaitAfter: true });
    await sleep(1200);
    const T2 = tabByFragment(await getTabs(browser), "l2");
    checks.check("foreground link 2 opened a new tab", Boolean(T2), `id=${T2?.id}`);
    if (!T2) return;
    const activeAfterT2 = await getActiveTab(browser);
    checks.equals("foreground link 2 tab becomes active", activeAfterT2?.id, T2.id);

    const mru = await getMruForWindow(browser, windowId);
    ctx.log(`MRU after two foreground link opens: ${JSON.stringify(mru)}`);
    checks.equals("MRU top three reflect visit order", mruIds(mru, 3), [T2.id, pageTab.id, T1.id]);

    const flip1 = await flipAndWait(browser, pageTab.id);
    ctx.log(`flip after foreground opens: ${JSON.stringify(flip1)}`);
    checks.check("Alt+N delivered", flip1.delivered?.ok === true, JSON.stringify(flip1.delivered));
    checks.equals("Alt+N after foreground opens -> page tab", flip1.after, pageTab.id);

    await closeTab(browser, pageTab.id);
    const afterClose = await waitForActiveTab(browser, T2.id, 6000);
    checks.equals("closing page tab -> link 2 tab", afterClose?.id, T2.id);
  } finally {
    server.close();
  }
}

export async function htmlLinksBackground(ctx) {
  const { browser, checks } = ctx;
  const popup = await prepare(ctx, { flip: 1, ntsel: 0, reloc: 1, ntord: 0, log: true });
  await closePopup(ctx, popup);

  const { server, base } = await startLinkServer();
  try {
    const windowId = await mainWindowId(ctx);
    const A = await createTab(browser, { windowId });
    const B = await createTab(browser, { windowId });
    await sleep(600);
    await activateTab(browser, A.id);
    await sleep(250);
    await activateTab(browser, B.id);
    await sleep(300);

    const pageTab = await createTab(browser, { windowId, url: `${base}/links`, active: true });
    await sleep(900);
    const page = await puppeteerPageForUrl(browser, `${base}/links`);
    if (!page) {
      checks.check("link page loaded", false, "no puppeteer page");
      return;
    }
    await page.waitForSelector("#b1");
    checks.check("link page loaded", true, `tab=${pageTab.id}`);

    await page.keyboard.down("Control");
    await page.click("#b1", { noWaitAfter: true });
    await page.keyboard.up("Control");
    await sleep(1200);

    const b2Handle = await page.$("#b2");
    const box = b2Handle ? await b2Handle.boundingBox() : null;
    if (!box) {
      checks.check("link b2 visible for middle click", false, "no bounding box");
      return;
    }
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "middle" });
    await sleep(1200);

    const tabs = await getTabs(browser);
    const B1 = tabByFragment(tabs, "b1");
    const B2 = tabByFragment(tabs, "b2");
    checks.check("ctrl+click background link opened", Boolean(B1), `id=${B1?.id}`);
    checks.check("middle-click background link opened", Boolean(B2), `id=${B2?.id}`);
    if (!B1 || !B2) return;

    const activeAfterOpens = await getActiveTab(browser);
    checks.equals("background link opens keep current tab active", activeAfterOpens?.id, pageTab.id);

    const mru = await getMruForWindow(browser, windowId);
    ctx.log(`MRU after two background link opens: ${JSON.stringify(mru)}`);
    checks.equals("background links do not outrank page tab", mruIds(mru, 1), [pageTab.id]);
    checks.check(
      "background links are not in top three",
      ![B1.id, B2.id].some((id) => mruIds(mru, 3).includes(id)),
      mruIds(mru, 3).join(","),
    );

    const flip1 = await flipAndWait(browser, B.id);
    ctx.log(`flip after background opens: ${JSON.stringify(flip1)}`);
    checks.check("Alt+N delivered", flip1.delivered?.ok === true, JSON.stringify(flip1.delivered));
    checks.equals("Alt+N after background opens -> previous visited tab", flip1.after, B.id);

    await activateTab(browser, B1.id);
    await sleep(600);
    await closeTab(browser, B1.id);
    const afterCloseVisited = await waitForActiveTab(browser, B.id, 6000);
    checks.equals("closing a visited background link -> previous tab", afterCloseVisited?.id, B.id);

    await closeTab(browser, B2.id);
    await sleep(500);
    await activateTab(browser, A.id);
    await sleep(700);
    const activeAfterManual = await getActiveTab(browser);
    checks.equals(
      "manual activation not hijacked after closing background links",
      activeAfterManual?.id,
      A.id,
    );
  } finally {
    server.close();
  }
}

export async function htmlLinksBackgroundNtsel1(ctx) {
  const { browser, checks } = ctx;
  const popup = await prepare(ctx, { flip: 1, ntsel: 1, reloc: 1, ntord: 0, log: true });
  await closePopup(ctx, popup);

  const { server, base } = await startLinkServer();
  try {
    const windowId = await mainWindowId(ctx);
    const A = await createTab(browser, { windowId });
    const B = await createTab(browser, { windowId });
    await sleep(600);
    await activateTab(browser, A.id);
    await sleep(250);
    await activateTab(browser, B.id);
    await sleep(300);

    const pageTab = await createTab(browser, { windowId, url: `${base}/links`, active: true });
    await sleep(900);
    const page = await puppeteerPageForUrl(browser, `${base}/links`);
    if (!page) {
      checks.check("link page loaded", false, "no puppeteer page");
      return;
    }
    await page.waitForSelector("#b1");
    checks.check("link page loaded", true, `tab=${pageTab.id}`);

    await page.keyboard.down("Control");
    await page.click("#b1", { noWaitAfter: true });
    await page.keyboard.up("Control");
    await sleep(1200);

    const b2Handle = await page.$("#b2");
    const box = b2Handle ? await b2Handle.boundingBox() : null;
    if (!box) {
      checks.check("link b2 visible for middle click", false, "no bounding box");
      return;
    }
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "middle" });
    await sleep(1200);

    const tabs = await getTabs(browser);
    const B1 = tabByFragment(tabs, "b1");
    const B2 = tabByFragment(tabs, "b2");
    checks.check("ctrl+click background link opened", Boolean(B1), `id=${B1?.id}`);
    checks.check("middle-click background link opened", Boolean(B2), `id=${B2?.id}`);
    if (!B1 || !B2) return;

    const activeAfterOpens = await getActiveTab(browser);
    checks.equals(
      "ntsel=1 keeps current tab active for background links",
      activeAfterOpens?.id,
      pageTab.id,
    );
    checks.equals(
      "background links do not outrank page tab with ntsel=1",
      mruIds(await getMruForWindow(browser, windowId), 1),
      [pageTab.id],
    );

    const flip1 = await flipAndWait(browser, B.id);
    checks.equals("Alt+N after background links -> previous visited tab", flip1.after, B.id);

    await activateTab(browser, B1.id);
    await sleep(600);
    await closeTab(browser, B1.id);
    const afterClose = await waitForActiveTab(browser, B.id, 6000);
    checks.equals("closing visited background link -> previous tab", afterClose?.id, B.id);
  } finally {
    server.close();
  }
}

async function flipInWindow(ctx, windowId) {  const { page } = await openPopupPage(ctx.browser, ctx.extensionId, windowId);
  await triggerPopupFlipAction(page);
}

export async function multiLinkTabs(ctx) {
  const { browser, checks } = ctx;
  const popup = await prepare(ctx, { flip: 1, ntsel: 0, reloc: 1, ntord: 0, log: true });
  await closePopup(ctx, popup);

  const { windowId, tabs } = await setupTabs(ctx, 3);
  const [A, B, C] = tabs;
  await waitForMruOrder(browser, windowId, [C.id, B.id, A.id]);

  const links = [];
  for (let i = 0; i < 5; i += 1) {
    links.push(await createTab(browser, { windowId, openerTabId: C.id, active: false }));
  }
  await sleep(1200);

  const mruAfterLinks = await getMruForWindow(browser, windowId);
  ctx.log(`MRU after 5 background links from C: ${JSON.stringify(mruAfterLinks)}`);
  checks.equals("C stays most recent after background links", mruIds(mruAfterLinks, 1), [C.id]);
  checks.equals("visited tabs keep relative MRU (C,B,A)", mruIds(mruAfterLinks, 3), [C.id, B.id, A.id]);
  checks.check(
    "all five background links tracked",
    links.every((link) => (mruAfterLinks ?? []).some((entry) => entry.tabId === link.id)),
    links.map((l) => l.id).join(","),
  );

  const flip1 = await flipAndWait(browser, B.id);
  checks.equals("Alt+N goes to B after background links", flip1.after, B.id);

  await activateTab(browser, links[0].id);
  await sleep(400);
  await activateTab(browser, links[1].id);
  await sleep(700);

  const flip2 = await flipAndWait(browser, links[0].id);
  checks.equals("Alt+N after visiting two links returns to first link", flip2.after, links[0].id);

  await closeTab(browser, links[1].id);
  const afterCloseVisited = await waitForActiveTab(browser, links[0].id, 6000);
  checks.equals("closing visited link -> previous visited link", afterCloseVisited?.id, links[0].id);

  await closeTab(browser, links[4].id);
  await sleep(500);
  await activateTab(browser, links[2].id);
  await sleep(700);
  const activeAfterManual = await getActiveTab(browser);
  checks.equals(
    "manual activation not hijacked after closing a background link",
    activeAfterManual?.id,
    links[2].id,
  );
}

export async function backgroundLinkClose(ctx) {
  const { browser, checks } = ctx;
  const popup = await prepare(ctx, { flip: 1, ntsel: 0, reloc: 1, ntord: 0, log: true });
  await closePopup(ctx, popup);

  const { windowId, tabs } = await setupTabs(ctx, 2);
  const [A, B] = tabs;
  await waitForMruOrder(browser, windowId, [B.id, A.id]);

  await createTab(browser, { windowId, openerTabId: B.id, active: false });
  await sleep(1000);
  const beforeClose = await getMruForWindow(browser, windowId);
  checks.equals("background link does not outrank active tab B", mruIds(beforeClose, 1), [B.id]);

  await closeTab(browser, B.id);
  const afterClose = await waitForActiveTab(browser, A.id, 6000);
  checks.equals("closing active tab goes to A, not the background link", afterClose?.id, A.id);

  const afterState = await getMruForWindow(browser, windowId);
  checks.equals("A most recent after close", mruIds(afterState, 1), [A.id]);
}

export async function multiWindowMru(ctx) {
  const { browser, checks } = ctx;
  const popup = await prepare(ctx, { flip: 1, ntsel: 0, reloc: 1, ntord: 0, log: true });
  await closePopup(ctx, popup);

  const win1 = await mainWindowId(ctx);
  const A = await createTab(browser, { windowId: win1 });
  const B = await createTab(browser, { windowId: win1 });
  await sleep(600);
  await activateTab(browser, A.id);
  await sleep(250);
  await activateTab(browser, B.id);
  await sleep(500);

  const win2 = await evalSw(
    browser,
    async () => (await chrome.windows.create({ url: "about:blank", focused: false })).id,
  );
  await sleep(1000);
  const w2first = (await getTabsInWindow(browser, win2))[0];
  const D = await createTab(browser, { windowId: win2 });
  await sleep(500);
  await activateTab(browser, D.id);
  await sleep(600);

  const win3 = await evalSw(
    browser,
    async () => (await chrome.windows.create({ url: "about:blank", focused: false })).id,
  );
  await sleep(1000);
  const w3first = (await getTabsInWindow(browser, win3))[0];
  const F = await createTab(browser, { windowId: win3 });
  await sleep(500);
  await activateTab(browser, F.id);
  await sleep(600);

  await createTab(browser, { windowId: win2, openerTabId: D.id, active: false });
  await createTab(browser, { windowId: win2, openerTabId: D.id, active: false });
  await sleep(1000);

  checks.equals("win2 MRU top is D", mruIds(await getMruForWindow(browser, win2), 1), [D.id]);
  checks.equals("win1 MRU keeps B,A", mruIds(await getMruForWindow(browser, win1), 2), [B.id, A.id]);
  checks.equals("win3 MRU keeps F,E", mruIds(await getMruForWindow(browser, win3), 2), [F.id, w3first.id]);

  await flipInWindow(ctx, win2);
  const win2Active = await waitForActiveTabInWindow(browser, win2, w2first.id, 6000);
  checks.equals("flip in win2 -> its previous tab", win2Active, w2first.id);

  await closeTab(browser, F.id);
  const win3Active = await waitForActiveTabInWindow(browser, win3, w3first.id, 6000);
  checks.equals("close active in win3 -> previous tab", win3Active, w3first.id);

  await evalSw(browser, (wid) => chrome.windows.remove(wid), win3);
  await sleep(800);
  checks.check("closed window tracker removed", (await getMruForWindow(browser, win3)) === null);
  checks.equals("win1 MRU still keeps B,A", mruIds(await getMruForWindow(browser, win1), 2), [B.id, A.id]);
}

export async function multiLinkWindows(ctx) {
  const { browser, checks } = ctx;
  const popup = await prepare(ctx, { flip: 1, ntsel: 0, reloc: 1, ntord: 0, log: true });
  await closePopup(ctx, popup);

  const win1 = await mainWindowId(ctx);
  const A = await createTab(browser, { windowId: win1 });
  const B = await createTab(browser, { windowId: win1 });
  await sleep(600);
  await activateTab(browser, A.id);
  await sleep(250);
  await activateTab(browser, B.id);
  await sleep(500);

  const newWindows = [];
  for (let i = 1; i <= 3; i += 1) {
    const id = await evalSw(
      browser,
      async (n) => (await chrome.windows.create({ url: `about:blank#w${n}`, focused: false })).id,
      i,
    );
    newWindows.push(id);
  }
  await sleep(1500);

  for (const windowId of newWindows) {
    const tabsInWindow = await getTabsInWindow(browser, windowId);
    const first = tabsInWindow[0];
    checks.check(
      `window ${windowId} created and tracked`,
      Boolean(first),
      first ? `first tab id=${first.id}` : "no tabs found",
    );
    if (!first) continue;

    const second = await createTab(browser, { windowId });
    await sleep(500);
    await activateTab(browser, second.id);
    await sleep(600);
    await closeTab(browser, second.id);
    const active = await waitForActiveTabInWindow(browser, windowId, first.id, 6000);
    checks.equals(`window ${windowId}: close -> first tab`, active, first.id);
  }

  checks.equals("main window MRU keeps B,A", mruIds(await getMruForWindow(browser, win1), 2), [B.id, A.id]);

  await evalSw(browser, (wid) => chrome.windows.remove(wid), newWindows[0]);
  await sleep(800);
  checks.check("closed window tracker removed", (await getMruForWindow(browser, newWindows[0])) === null);
  checks.equals(
    "main window MRU still keeps B,A",
    mruIds(await getMruForWindow(browser, win1), 2),
    [B.id, A.id],
  );
}

export async function backgroundLinkNtsel1(ctx) {
  const { browser, checks } = ctx;
  const popup = await prepare(ctx, { flip: 1, ntsel: 1, reloc: 1, ntord: 0, log: true });
  await closePopup(ctx, popup);

  const { windowId, tabs } = await setupTabs(ctx, 2);
  const [A, B] = tabs;
  await waitForMruOrder(browser, windowId, [B.id, A.id]);

  const link = await createTab(browser, { windowId, openerTabId: B.id, active: false });
  await sleep(1200);
  const activeAfterOpen = await getActiveTab(browser);
  ctx.log(`ntsel=1 background link: active=${activeAfterOpen?.id} link=${link.id}`);
  checks.equals("ntsel=1 does not steal focus for link-opened tabs", activeAfterOpen?.id, B.id);
  checks.equals("link does not outrank the active tab", mruIds(await getMruForWindow(browser, windowId), 2), [B.id, A.id]);

  const flip = await flipAndWait(browser, A.id);
  checks.equals("Alt+N after background link open -> A", flip.after, A.id);

  const foreground = await createTab(browser, {
    windowId,
    openerTabId: B.id,
    active: true,
  });
  await sleep(1000);
  const activeAfterForeground = await getActiveTab(browser);
  checks.equals("foreground link tab stays active", activeAfterForeground?.id, foreground.id);
  checks.equals(
    "foreground link becomes MRU head",
    mruIds(await getMruForWindow(browser, windowId), 1),
    [foreground.id],
  );

  await closeTab(browser, foreground.id);
  const afterForegroundClose = await waitForActiveTab(browser, A.id, 6000);
  checks.equals("closing foreground link -> previous tab A", afterForegroundClose?.id, A.id);

  await activateTab(browser, link.id);
  await sleep(600);
  checks.equals(
    "visited background link becomes MRU head",
    mruIds(await getMruForWindow(browser, windowId), 1),
    [link.id],
  );

  await closeTab(browser, link.id);
  const afterLinkClose = await waitForActiveTab(browser, A.id, 6000);
  checks.equals("closing visited link -> previous tab A", afterLinkClose?.id, A.id);
}

export const scenarios = {
  smoke,
  "close-mru": closeMru,
  flip,
  "background-tab-mru": backgroundTabMru,
  "background-close-hijack": backgroundCloseHijack,
  "newtab-active-tracking": newtabActiveTracking,
  dormancy,
  restart,
  "multi-window": multiWindow,
  "multi-link-tabs": multiLinkTabs,
  "background-link-close": backgroundLinkClose,
  "background-link-ntsel1": backgroundLinkNtsel1,
  "html-links-foreground": htmlLinksForeground,
  "html-links-background": htmlLinksBackground,
  "html-links-background-ntsel1": htmlLinksBackgroundNtsel1,
  "multi-window-mru": multiWindowMru,
  "multi-link-windows": multiLinkWindows,
};
