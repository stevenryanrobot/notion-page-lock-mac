/* This is prepended to Notion's existing sandboxed preload. No bridge is exposed to the website. */
(() => {
  const { ipcRenderer, webFrame, contextBridge } = require("electron");
  let state = { corrupt: true, lockedIds: [], protectedIds: [] };
  try {
    state = ipcRenderer.sendSync("npl:state");
  } catch {}
  let host,
    shadow,
    blocked = false,
    boot = true,
    currentId = null,
    blockingIds = [];
  const uid = "npl-" + Math.random().toString(36).slice(2);
  const css = `html[data-npl-blocked] body { visibility:hidden !important; pointer-events:none !important; user-select:none !important; } html[data-npl-blocked] body * { visibility:hidden !important; } html[data-npl-blocked] { background:#191919 !important; overflow:hidden !important; }`;
  webFrame.insertCSS(css, { cssOrigin: "user" });
  function normalize(s) {
    return (s || "").replaceAll("-", "").toLowerCase();
  }
  function idOf(url) {
    try {
      const u = new URL(url, location.href);
      if (!/(^|\.)notion\.(so|com)$/.test(u.hostname)) return null;
      const s =
        u.searchParams.get("p") ||
        u.pathname.split("/").filter(Boolean).at(-1) ||
        "";
      return (
        normalize(
          s.match(
            /([a-f\d]{32}|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})$/i,
          )?.[1],
        ) || null
      );
    } catch {
      return null;
    }
  }
  function setBlocked(value) {
    if (value && !blocked) {
      try {
        window.getSelection()?.removeAllRanges();
      } catch {}
    }
    blocked = value;
    if (!document.documentElement) return;
    document.documentElement.toggleAttribute("data-npl-blocked", value);
    if (document.body) document.body.inert = value;
    if (host) {
      host.style.setProperty("display", value ? "flex" : "none", "important");
    }
  }
  function check() {
    currentId = idOf(location.href);
    blockingIds = state.lockedIds.includes(currentId) ? [currentId] : [];
    // Block peeks and mounted protected page blocks too. Page references may conservatively trigger this.
    if (state.lockedIds.length) {
      for (const n of document.querySelectorAll("[data-block-id]")) {
        const id = normalize(n.getAttribute("data-block-id"));
        if (state.lockedIds.includes(id) && !blockingIds.includes(id))
          blockingIds.push(id);
      }
    }
    setBlocked(state.corrupt || blockingIds.length > 0 || boot);
  }
  function mount() {
    if (!document.documentElement) return;
    if (host) {
      if (!host.isConnected) document.documentElement.appendChild(host);
      return;
    }
    host = document.createElement("div");
    host.id = uid;
    host.style.cssText =
      "position:fixed!important;inset:0!important;z-index:2147483647!important;background:#191919!important;align-items:center!important;justify-content:center!important;visibility:visible!important;";
    shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `<style>:host{color:#f1f1ef;font:15px -apple-system,BlinkMacSystemFont,sans-serif}.card{text-align:center;max-width:420px;padding:40px}svg{width:46px;height:46px;stroke:#c4b5fd;margin:0 0 24px}h1{font-size:25px;letter-spacing:-.6px;margin:0 0 12px}p{color:#aaa9a4;line-height:1.8;margin:0 0 26px}button{font:inherit;border:0;border-radius:8px;padding:12px 23px;cursor:pointer;background:#e0d7ff;color:#292336}button.secondary{background:transparent;color:#aaa9a4;margin-left:10px}.note{font-size:12px;margin:26px 0 0;color:#777772}</style><section class="card" role="dialog" aria-modal="true" aria-label="页面已锁定"><svg viewBox="0 0 48 48" fill="none" stroke-width="2.5"><rect x="11" y="22" width="26" height="21" rx="5"/><path d="M16 22v-9a8 8 0 0 1 16 0v9"/><path d="M24 30v6"/></svg><h1>这个页面，留给自己</h1><p>内容已隐藏。输入隐私锁密码后查看。<br>切换到其他 App 后会重新锁定。</p><button id="unlock">解锁查看</button><button class="secondary" id="back">返回上一页</button><p class="note">Notion 隐私锁 · 仅保护当前桌面副本</p></section>`;
    shadow
      .getElementById("unlock")
      .addEventListener("click", () =>
        ipcRenderer.send("npl:unlock", blockingIds),
      );
    shadow
      .getElementById("back")
      .addEventListener("click", () => ipcRenderer.send("npl:back"));
    document.documentElement.appendChild(host);
    check();
  }
  new MutationObserver(() => {
    mount();
    check();
  }).observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-block-id"],
  });
  ipcRenderer.on("npl:state-updated", (_, s) => {
    state = s;
    check();
  });
  ipcRenderer.on("npl:cloak", () => setBlocked(true));
  for (const type of ["pointerdown", "focusin"])
    document.addEventListener(type, () => ipcRenderer.send("npl:active"), true);
  document.addEventListener(
    "click",
    (e) => {
      const a = e.target?.closest?.("a[href]");
      if (a && state.lockedIds.includes(idOf(a.href))) setBlocked(true);
    },
    true,
  );
  document.addEventListener(
    "keydown",
    (e) => {
      if (blocked && e.target !== host) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true,
  );
  for (const type of ["copy", "cut", "dragstart", "contextmenu"])
    document.addEventListener(
      type,
      (e) => {
        if (blocked) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      },
      true,
    );
  addEventListener("popstate", check);
  addEventListener("hashchange", check);
  addEventListener("npl-history-change", check);
  try {
    contextBridge.executeInMainWorld({
      func: () => {
        for (const method of ["pushState", "replaceState"]) {
          const original = history[method];
          history[method] = function (...args) {
            const result = Reflect.apply(original, this, args);
            dispatchEvent(new Event("npl-history-change"));
            return result;
          };
        }
      },
    });
  } catch {
    state = { ...state, corrupt: true };
  }
  // Native navigation notifications supplement DOM observation for SPA history changes.
  ipcRenderer.on("npl:route", check);
  ipcRenderer.on("npl:request-unlock", () => {
    check();
    ipcRenderer.send("npl:unlock", blockingIds);
  });
  document.addEventListener(
    "DOMContentLoaded",
    () => {
      boot = false;
      mount();
      check();
    },
    { once: true },
  );
  mount();
  check();
})();
