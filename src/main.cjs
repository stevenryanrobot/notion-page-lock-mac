"use strict";
const {
  app,
  BrowserWindow,
  Menu,
  MenuItem,
  ipcMain,
  webContents,
  powerMonitor,
  dialog,
  globalShortcut,
  systemPreferences,
} = require("electron");
const path = require("node:path");
const { Vault, pageId } = require("./core.cjs");
// Give the local desktop copy its own cookies, caches and settings.
app.setName("Notion Page Lock");
app.setPath("userData", path.join(app.getPath("appData"), "Notion Page Lock"));
// Never replace the user's notion:// default handler.
app.setAsDefaultProtocolClient = () => false;
// The copy must not compete with the official client for login items or global shortcuts.
app.setLoginItemSettings({ openAtLogin: false });
app.setLoginItemSettings = () => {};
globalShortcut.register = () => false;
const vault = new Vault(path.join(app.getPath("userData"), "page-lock.json"));
let panel = null,
  context = null,
  lastTarget = null,
  authBusy = false,
  expiry = null;
const tracked = new Set();
function isNotion(wc) {
  try {
    return /(^|\.)notion\.(so|com)$/.test(new URL(wc.getURL()).hostname);
  } catch {
    return false;
  }
}
function send(wc, channel, ...args) {
  if (!wc.isDestroyed()) wc.send(channel, ...args);
}
function broadcast() {
  for (const wc of tracked) send(wc, "npl:state-updated", vault.state());
}
function lockAll() {
  vault.lockAll();
  clearTimeout(expiry);
  broadcast();
}
function target() {
  const focused = webContents.getFocusedWebContents();
  return focused && isNotion(focused)
    ? focused
    : lastTarget && !lastTarget.isDestroyed()
      ? lastTarget
      : [...tracked].find((w) => !w.isDestroyed() && isNotion(w));
}
function validPanel(event) {
  return (
    panel &&
    !panel.isDestroyed() &&
    event.sender === panel.webContents &&
    event.senderFrame === panel.webContents.mainFrame
  );
}
function closePanel() {
  if (panel && !panel.isDestroyed()) panel.close();
}
function openPanel(mode, wc, unlockIds = []) {
  if (panel && !panel.isDestroyed()) {
    panel.focus();
    return;
  }
  const id = wc ? pageId(wc.getURL()) : null;
  context = {
    mode,
    wc,
    id,
    unlockIds,
    generation: vault.generation,
    title: wc?.getTitle() || "未命名页面",
  };
  panel = new BrowserWindow({
    width: 490,
    height: mode === "setup" ? 540 : 490,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: "Notion 隐私锁",
    backgroundColor: "#20201f",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "panel-preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  panel.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  panel.webContents.on("will-navigate", (e) => e.preventDefault());
  panel.on("closed", () => {
    panel = null;
    context = null;
  });
  panel.once("ready-to-show", () => panel?.show());
  panel.loadFile(path.join(__dirname, "panel.html"));
}
function unlock(wc, ids = []) {
  if (!vault.data.credential || vault.corrupt) return;
  const unlockIds = [
    ...new Set(Array.isArray(ids) ? ids.slice(0, 500) : []),
  ].filter(
    (id) => typeof id === "string" && Object.hasOwn(vault.data.pages, id),
  );
  if (!unlockIds.length) {
    const id = wc && pageId(wc.getURL());
    if (id && Object.hasOwn(vault.data.pages, id)) unlockIds.push(id);
  }
  if (unlockIds.length) openPanel("unlock", wc, unlockIds);
}
function protect() {
  const wc = target(),
    id = wc && pageId(wc.getURL());
  if (!id) {
    dialog.showMessageBox({
      type: "info",
      message: "先打开要保护的 Notion 页面",
      detail: "进入页面正文后，再选择“锁定当前页面”。",
    });
    return;
  }
  if (vault.corrupt) {
    dialog.showErrorBox(
      "配置不可读",
      "请恢复 page-lock.json 的备份。隐私锁保持遮挡，不会自动取消保护。",
    );
    return;
  }
  if (!vault.data.credential) {
    openPanel("setup", wc);
    return;
  }
  try {
    vault.protect(id, wc.getTitle());
    broadcast();
  } catch (e) {
    dialog.showErrorBox("未能保存保护", e.message);
  }
}
const originalSetMenu = Menu.setApplicationMenu.bind(Menu);
Menu.setApplicationMenu = (menu) => {
  if (menu && !menu.items.some((i) => i.id === "npl-menu"))
    menu.append(
      new MenuItem({
        id: "npl-menu",
        label: "隐私锁",
        submenu: [
          {
            label: "锁定当前页面",
            accelerator: "CommandOrControl+Shift+L",
            click: protect,
          },
          {
            label: "解锁查看…",
            click: () => {
              const wc = target();
              if (wc) send(wc, "npl:request-unlock");
            },
          },
          {
            label: "立即重新上锁",
            accelerator: "CommandOrControl+Alt+L",
            click: lockAll,
          },
          { type: "separator" },
          {
            label: "管理页面保护…",
            click: () =>
              openPanel(vault.data.credential ? "manage" : "setup", target()),
          },
          {
            label: "关于本机隐私锁",
            click: () =>
              dialog.showMessageBox({
                message: "Notion 隐私锁 · 0.1.0",
                detail:
                  "仅保护这个桌面副本中的指定页面视图。离开 App、锁屏或解锁 5 分钟后重新上锁。子页面须分别添加。\n\n这是本地查看遮挡，不加密 Notion 云端原文。搜索摘要、同步块、AI、导出、浏览器及其他设备仍可能显示内容。副本需要单独登录；通过邮件验证码登录最可靠。",
              }),
          },
        ],
      }),
    );
  originalSetMenu(menu);
};
function track(wc, frameURL) {
  let allowed = false;
  try {
    const u = new URL(frameURL || wc.getURL());
    allowed =
      u.protocol === "https:" && /(^|\.)notion\.(so|com)$/.test(u.hostname);
  } catch {}
  if (!allowed) return false;
  wc._nplLoginMode = /^\/login(?:\/|$)/.test(
    new URL(frameURL || wc.getURL()).pathname,
  );
  if (tracked.has(wc)) return true;
  tracked.add(wc);
  wc.on("focus", () => {
    if (isNotion(wc)) lastTarget = wc;
  });
  wc.on("before-input-event", () => {
    if (isNotion(wc)) lastTarget = wc;
  });
  wc.on("did-start-navigation", (_e, url, inPlace, isMain) => {
    if (isMain && vault.state().lockedIds.includes(pageId(url)))
      send(wc, "npl:cloak");
  });
  wc.on("did-navigate-in-page", (_e, url, isMain) => {
    send(wc, "npl:route");
    if (isMain) {
      try {
        const nextLogin = /^\/login(?:\/|$)/.test(new URL(url).pathname);
        if (nextLogin !== wc._nplLoginMode) {
          wc._nplLoginMode = nextLogin;
          wc.reload();
        }
      } catch {}
    }
  });
  wc.on("did-finish-load", () => {
    if (
      isNotion(wc) &&
      (wc.isFocused() || !lastTarget || lastTarget.isDestroyed())
    )
      lastTarget = wc;
    send(wc, "npl:state-updated", vault.state());
  });
  wc.on("destroyed", () => tracked.delete(wc));
  return true;
}
// Register on the document-start handshake; Electron 43 omits preload paths from getLastWebPreferences.
ipcMain.on("npl:state", (e) => {
  e.returnValue =
    e.senderFrame === e.sender.mainFrame && track(e.sender, e.senderFrame.url)
      ? vault.state()
      : { corrupt: true, lockedIds: [], protectedIds: [] };
});
ipcMain.on("npl:unlock", (e, ids) => {
  if (tracked.has(e.sender) && isNotion(e.sender)) unlock(e.sender, ids);
});
ipcMain.on("npl:active", (e) => {
  if (
    tracked.has(e.sender) &&
    e.senderFrame === e.sender.mainFrame &&
    isNotion(e.sender)
  )
    lastTarget = e.sender;
});
ipcMain.on("npl:back", (e) => {
  if (tracked.has(e.sender) && e.sender.navigationHistory.canGoBack())
    e.sender.navigationHistory.goBack();
});
ipcMain.handle("npl:panel-info", (e) => {
  if (!validPanel(e)) throw Error("Invalid sender");
  return {
    mode: context.mode,
    pages: Object.entries(vault.data.pages).map(([id, p]) => ({
      id,
      title: p.title,
    })),
  };
});
ipcMain.on("npl:panel-close", (e) => {
  if (validPanel(e)) closePanel();
});
ipcMain.handle("npl:panel-submit", async (e, values) => {
  if (!validPanel(e) || authBusy) return { ok: false, error: "请稍候再试。" };
  authBusy = true;
  const ctx = context;
  const generation = vault.generation;
  try {
    if (!values || typeof values.password !== "string")
      throw Error("请输入密码。");
    if (ctx.mode === "setup") {
      if (!ctx.id) throw Error("请先打开要保护的 Notion 页面。");
      await vault.setup(values.password);
      vault.protect(ctx.id, ctx.title);
    } else {
      if (!(await vault.verify(values.password))) throw Error("密码不正确。");
      if (
        context !== ctx ||
        generation !== vault.generation ||
        ctx.generation !== generation
      )
        throw Error("锁定状态已改变，请关闭窗口后重试。");
      if (ctx.mode === "manage") {
        if (!Object.hasOwn(vault.data.pages, values.id))
          throw Error("页面不存在。");
        vault.remove(values.id);
      } else {
        for (const id of ctx.unlockIds) vault.unlocked.add(id);
        clearTimeout(expiry);
        expiry = setTimeout(lockAll, 5 * 60 * 1000);
      }
    }
    broadcast();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    authBusy = false;
  }
});
app.whenReady().then(() => {
  // A password window is part of this app. Window blur alone cannot distinguish it
  // from switching to another application; AppKit's application notifications can.
  const subscriptions = [
    "NSApplicationWillResignActiveNotification",
    "NSApplicationDidHideNotification",
  ].map((name) => systemPreferences.subscribeLocalNotification(name, lockAll));
  app.once("will-quit", () =>
    subscriptions.forEach((id) =>
      systemPreferences.unsubscribeLocalNotification(id),
    ),
  );
  powerMonitor.on("lock-screen", lockAll);
  powerMonitor.on("suspend", lockAll);
  if (vault.corrupt)
    dialog.showErrorBox(
      "隐私锁配置不可读",
      "页面将保持隐藏。请恢复锁定配置备份。",
    );
});
module.exports = { vault, lockAll };
