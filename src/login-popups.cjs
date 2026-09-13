"use strict";

const authPaths = new Set([
  "/verifyNoPopupBlockerHtmlAndRedirect",
  "/googlepopupredirect",
  "/applepopupredirect",
  "/chatgptloginredirect",
  "/microsoftpopupredirect",
]);
const callbackPaths = new Set([
  "/appleauthcallback", "/chatgptauthcallback", "/chatgptclientauthcallback",
  "/oauth2callback", "/microsoftauthcallback",
]);
const authWindows = new WeakSet();
const redirectWindows = new WeakMap();
const providerOrigins = new Set([
  "https://auth.openai.com", "https://appleid.apple.com",
  "https://account.apple.com", "https://accounts.google.com",
  "https://login.microsoftonline.com", "https://login.live.com",
]);
const webLoginPattern = /^\/(?:login(?:\/|$)|signup(?:\/|$)|appleauthcallback$|chatgptauthcallback$|chatgptclientauthcallback$|oauth2callback$|microsoftauthcallback$)/;

function isWebLoginURL(value) {
  const url = notionURL(value);
  return !!url && webLoginPattern.test(url.pathname);
}

// Used by the version-checked vendor navigation guard. No ordinary tab gains
// permission to visit an identity provider with its privileged Notion preload.
function isAllowedLoginNavigation(wc, value) {
  if (!authWindows.has(wc)) return false;
  if (notionURL(value)) return true;
  try {
    const url = new URL(value);
    return !url.username && !url.password && providerOrigins.has(url.origin);
  } catch { return false; }
}

function notionURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      ["notion.so", "notion.com"].some(
        (host) => url.hostname === host || url.hostname.endsWith("." + host),
      )
      ? url
      : null;
  } catch {
    return null;
  }
}

function isLoginPopup(openerURL, destination) {
  const opener = notionURL(openerURL);
  if (!opener || !/^\/(?:login|signup)(?:\/|$)/.test(opener.pathname)) return false;
  // Notion first probes popup support using a blank window, then navigates it.
  if (["about:blank", "about:blank#blocked"].includes(destination)) return true;
  const url = notionURL(destination);
  return !!url && authPaths.has(url.pathname);
}

function installLoginPopups(app) {
  const { BrowserWindow } = require("electron");
  const options = (wc) => ({
    width: 560, height: 760, show: true, title: "Notion+ · 登录",
    webPreferences: {
      session: wc.session, preload: undefined, sandbox: true,
      contextIsolation: true, nodeIntegration: false,
      nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
      webSecurity: true,
    },
  });
  function isolate(child) {
    authWindows.add(child.webContents);
    child.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const guard = (event, url) => {
      if (url !== "about:blank" && !isAllowedLoginNavigation(child.webContents, url))
        event.preventDefault();
    };
    child.webContents.on("will-navigate", guard);
    child.webContents.on("will-redirect", guard);
  }
  app.on("web-contents-created", (_event, wc) => {
    // Apple and ChatGPT use a same-tab redirect, unlike Google's popup.
    // Move that entire flow to an unprivileged window and return only a known
    // Notion callback to the original tab, where Notion validates OAuth state.
    wc.on("will-navigate", (event, destination) => {
      if (authWindows.has(wc) || !isLoginPopup(wc.getURL(), destination)) return;
      const url = notionURL(destination);
      if (!url || !authPaths.has(url.pathname)) return;
      event.preventDefault();
      const existing = redirectWindows.get(wc);
      if (existing && !existing.isDestroyed()) { existing.focus(); return; }
      const child = new BrowserWindow(options(wc));
      isolate(child);
      redirectWindows.set(wc, child);
      let returning = false;
      const handoff = (event, destination) => {
        const url = notionURL(destination);
        if (!url || !callbackPaths.has(url.pathname)) return;
        event.preventDefault();
        if (returning || wc.isDestroyed()) return;
        returning = true;
        wc.loadURL(destination).then(() => {
          BrowserWindow.fromWebContents(wc)?.focus();
          if (!child.isDestroyed()) child.close();
        }).catch(() => { returning = false; });
      };
      child.webContents.on("will-navigate", handoff);
      child.webContents.on("will-redirect", handoff);
      const close = () => { if (!child.isDestroyed()) child.close(); };
      wc.once("destroyed", close);
      child.once("closed", () => {
        redirectWindows.delete(wc);
        wc.removeListener("destroyed", close);
      });
      child.loadURL(destination).catch(() => {});
    });
    const setHandler = wc.setWindowOpenHandler.bind(wc);
    wc.setWindowOpenHandler = (vendorHandler) =>
      setHandler((details) => {
        if (authWindows.has(wc) || !isLoginPopup(wc.getURL(), details.url))
          return vendorHandler(details);
        return {
          action: "allow",
          overrideBrowserWindowOptions: options(wc),
        };
      });
    wc.on("did-create-window", (child, details) => {
      if (!isLoginPopup(wc.getURL(), details.url)) return;
      isolate(child);
    });
  });
}

module.exports = { isLoginPopup, installLoginPopups, isAllowedLoginNavigation, isWebLoginURL, webLoginPattern };
