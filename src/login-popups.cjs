"use strict";

const authPaths = new Set([
  "/verifyNoPopupBlockerHtmlAndRedirect",
  "/googlepopupredirect",
  "/applepopupredirect",
  "/chatgptloginredirect",
  "/microsoftpopupredirect",
]);

function notionURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
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
  if (!opener || !/^\/login(?:\/|$)/.test(opener.pathname)) return false;
  // Notion first probes popup support using a blank window, then navigates it.
  if (["about:blank", "about:blank#blocked"].includes(destination)) return true;
  const url = notionURL(destination);
  return !!url && authPaths.has(url.pathname);
}

function installLoginPopups(app) {
  app.on("web-contents-created", (_event, wc) => {
    const setHandler = wc.setWindowOpenHandler.bind(wc);
    wc.setWindowOpenHandler = (vendorHandler) =>
      setHandler((details) => {
        if (!isLoginPopup(wc.getURL(), details.url))
          return vendorHandler(details);
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            width: 560,
            height: 760,
            show: true,
            webPreferences: {
              session: wc.session,
              preload: undefined,
              sandbox: true,
              contextIsolation: true,
              nodeIntegration: false,
              nodeIntegrationInWorker: false,
              nodeIntegrationInSubFrames: false,
              webSecurity: true,
            },
          },
        };
      });
    wc.on("did-create-window", (child, details) => {
      if (!isLoginPopup(wc.getURL(), details.url)) return;
      child.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      // Auth stays in a sandboxed web window; it never gets our password bridge.
      const guard = (event, url) => {
        try {
          if (new URL(url).protocol === "https:" || url === "about:blank")
            return;
        } catch {}
        event.preventDefault();
      };
      child.webContents.on("will-navigate", guard);
      child.webContents.on("will-redirect", guard);
    });
  });
}

module.exports = { isLoginPopup, installLoginPopups };
