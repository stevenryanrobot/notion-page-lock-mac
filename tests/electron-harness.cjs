// Isolated fixture: no Notion account, no external network, no production profile.
const { app, BrowserWindow, Menu, session, powerMonitor } = require("electron");
const path = require("node:path"),
  fs = require("node:fs"),
  assert = require("node:assert/strict");
const base = process.env.NPL_HARNESS_OUTPUT;
if (!base) throw Error("Harness output directory required");
const progress = (message) => {
  fs.mkdirSync(base, { recursive: true });
  fs.appendFileSync(path.join(base, "progress.log"), message + "\n");
};
progress("Main started");
fs.mkdirSync(base, { recursive: true });
app.setPath("appData", path.join(base, "profile"));
fs.mkdirSync(app.getPath("appData"), { recursive: true });
app.setLoginItemSettings = () => {};
app.on("web-contents-created", (_, wc) => {
  const execute = wc.executeJavaScript.bind(wc);
  wc.executeJavaScript = async (source, ...args) => {
    const label = `renderer ${wc.id}: ${source.slice(0, 90)}`;
    progress("Evaluate " + label);
    let timer;
    try {
      const result = await Promise.race([
        execute(source, ...args),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error("Timed out: " + label)), 5000);
        }),
      ]);
      progress("Evaluated " + label);
      return result;
    } finally {
      clearTimeout(timer);
    }
  };
  wc.on("render-process-gone", (_, details) =>
    progress("Renderer exited " + JSON.stringify(details)),
  );
});
const { vault, lockAll } = require("./page-lock/main.cjs");
const A = "12345678123412341234123456789abc",
  B = "abcdefabcdefabcdefabcdefabcdefab";
const password = "test-only-password-123";
const report = [];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const record = (name) => {
  report.push({ name, passed: true });
  progress("PASS " + name);
  console.log("PASS", name);
};
let win;
async function view() {
  return win.webContents.executeJavaScript(
    `({blocked:document.documentElement.hasAttribute('data-npl-blocked'), visibility:getComputedStyle(document.body).visibility,inert:document.body.inert, bridge:typeof window.lockPanel, secretVisible:getComputedStyle(document.getElementById('secret')).visibility})`,
  );
}
async function verifyHidden(name) {
  const s = await view();
  assert(s.blocked);
  assert(s.inert);
  assert.equal(s.visibility, "hidden");
  assert.equal(s.secretVisible, "hidden");
  record(name);
}
app.whenReady().then(async () => {
  try {
    progress("App ready");
    session.defaultSession.protocol.handle(
      "https",
      () =>
        new Response(
          `<!doctype html><html><head><title>Fixture page</title></head><body><h1 id="secret">PRIVATE TEST CONTENT</h1><p>Only a synthetic test fixture.</p><a id="protected" href="/${A}">Protected</a><script>window.framesSeen=[];function sample(){framesSeen.push({path:location.pathname,visible:getComputedStyle(document.body).visibility});if(framesSeen.length<300)requestAnimationFrame(sample)}requestAnimationFrame(sample);</script></body></html>`,
          { headers: { "Content-Type": "text/html" } },
        ),
    );
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([{ label: "Test", submenu: [] }]),
    );
    win = new BrowserWindow({
      width: 1100,
      height: 740,
      show: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        backgroundThrottling: false,
        preload: path.join(__dirname, "tab_browser_view/preload.js"),
      },
    });
    win.webContents.on("preload-error", (_e, p, error) =>
      console.error("PRELOAD", p, error),
    );
    win.webContents.on("console-message", (e) => {
      if (e.level === "error") console.error("RENDERER", e.message);
    });
    progress("Loading initial fixture");
    await win.loadURL("https://app.notion.com/" + A);
    progress("Initial fixture loaded");
    await pause(200);
    assert.equal((await view()).visibility, "visible");
    const items = Menu.getApplicationMenu().items.find(
      (i) => i.id === "npl-menu",
    ).submenu.items;
    items[0].click();
    await pause(400);
    const setup = BrowserWindow.getAllWindows().find((w) => w !== win);
    assert(setup);
    assert.equal(
      (await setup.webContents.executeJavaScript("lockPanel.info()")).mode,
      "setup",
    );
    const created = await setup.webContents.executeJavaScript(
      `lockPanel.submit({password:${JSON.stringify(password)}})`,
    );
    assert(created.ok, JSON.stringify(created));
    setup.close();
    await pause(100);
    await verifyHidden(
      "First-time native password setup immediately protects current page",
    );
    vault.protect(B, "Another private page");
    await win.loadURL("https://app.notion.com/" + A);
    await pause(200);
    await verifyHidden(
      "Protected page hidden on cold load, including child text and interaction",
    );
    const frames = await win.webContents.executeJavaScript("framesSeen");
    assert(!frames.some((f) => f.visible === "visible"));
    record("No visible body in sampled cold-load animation frames");
    assert.equal((await view()).bridge, "undefined");
    record("No password bridge exposed to remote Notion page");
    fs.writeFileSync(
      path.join(base, "lock-preview.png"),
      (await win.webContents.capturePage()).toPNG(),
    );
    const unlockItem = Menu.getApplicationMenu().items.find(
      (i) => i.id === "npl-menu",
    ).submenu.items[1];
    unlockItem.click();
    await pause(400);
    let panel = BrowserWindow.getAllWindows().find((w) => w !== win);
    assert(panel);
    const info = await panel.webContents.executeJavaScript("lockPanel.info()");
    assert.equal(info.mode, "unlock");
    let r = await panel.webContents.executeJavaScript(
      `lockPanel.submit({password:'bad password'})`,
    );
    assert(!r.ok);
    await verifyHidden("Wrong password leaves page hidden");
    await pause(700);
    r = await panel.webContents.executeJavaScript(
      `lockPanel.submit({password:${JSON.stringify(password)}})`,
    );
    assert(r.ok, JSON.stringify(r));
    panel.close();
    await pause(100);
    assert.equal((await view()).visibility, "visible");
    record("Correct password reveals page through authenticated local panel");
    assert(vault.state().lockedIds.includes(B));
    record("Unlocking one page keeps other protected pages locked");
    vault.remove(B);
    lockAll();
    await pause(80);
    await verifyHidden("Immediate relock hides an already mounted page");
    await win.loadURL("https://app.notion.com/" + B);
    await pause(100);
    assert.equal((await view()).visibility, "visible");
    record("Ordinary page stays readable");
    const sync = await win.webContents.executeJavaScript(
      `history.pushState({},'', '/${A}');({blocked:document.documentElement.hasAttribute('data-npl-blocked'),visibility:getComputedStyle(document.body).visibility})`,
    );
    assert(sync.blocked);
    assert.equal(sync.visibility, "hidden");
    record("SPA history change hides protected page synchronously");
    await win.webContents.executeJavaScript(
      `history.replaceState({},'', '/${B}')`,
    );
    await pause(80);
    assert.equal((await view()).visibility, "visible");
    await win.webContents.executeJavaScript(
      `const peek=document.createElement('div');peek.dataset.blockId='${A}';peek.textContent='PEEK SECRET';document.body.append(peek)`,
    );
    await pause(80);
    await verifyHidden("Protected block or peek hides enclosing view");
    vault.unlocked.add(A);
    win.webContents.send("npl:state-updated", vault.state());
    await pause(80);
    assert.equal((await view()).visibility, "visible");
    powerMonitor.emit("lock-screen");
    await pause(80);
    await verifyHidden("macOS lock-screen event clears unlocked session");
    app.show();
    win.focus();
    await pause(150);
    vault.unlocked.add(A);
    win.webContents.send("npl:state-updated", vault.state());
    await pause(60);
    app.hide();
    await pause(100);
    await verifyHidden("Losing application focus clears unlocked session");
    app.show();
    const second = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        backgroundThrottling: false,
        preload: path.join(__dirname, "tab_browser_view/preload.js"),
      },
    });
    await second.loadURL("https://app.notion.com/" + A);
    await pause(80);
    assert(await second.webContents.executeJavaScript("document.body.inert"));
    record("New windows inherit locked state");
    second.destroy();
    win.focus();
    await win.loadURL("https://app.notion.com/" + A);
    await pause(150);
    unlockItem.click();
    await pause(400);
    panel = BrowserWindow.getAllWindows().find((w) => w !== win);
    assert(panel);
    lockAll();
    const stale = await panel.webContents.executeJavaScript(
      `lockPanel.submit({password:${JSON.stringify(password)}})`,
    );
    assert(!stale.ok);
    await verifyHidden("Relock invalidates a pending authentication prompt");
    panel.destroy();
    win.focus();
    await pause(150);
    items[4].click();
    await pause(400);
    panel = BrowserWindow.getAllWindows().find((w) => w !== win);
    assert(panel);
    const removed = await panel.webContents.executeJavaScript(
      `lockPanel.submit({password:${JSON.stringify(password)},id:'${A}'})`,
    );
    assert(removed.ok, JSON.stringify(removed));
    panel.close();
    await pause(100);
    assert.deepEqual(vault.state().protectedIds, []);
    assert.equal((await view()).visibility, "visible");
    record("Authenticated removal durably clears page protection");
    win.webContents.send("npl:state-updated", {
      corrupt: true,
      lockedIds: [],
      protectedIds: [],
    });
    await pause(80);
    await verifyHidden("Unreadable configuration fails closed in renderer");
    fs.writeFileSync(
      path.join(base, "electron-results.json"),
      JSON.stringify({ passed: true, tests: report }, null, 2),
    );
    app.exit(0);
  } catch (e) {
    fs.writeFileSync(
      path.join(base, "electron-results.json"),
      JSON.stringify({ passed: false, tests: report, error: e.stack }, null, 2),
    );
    app.exit(1);
  }
});
