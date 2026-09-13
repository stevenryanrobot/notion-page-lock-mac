import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import * as asar from "@electron/asar";
import { fileURLToPath } from "node:url";
import { installAppIcon } from "./app-icon.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const original = process.argv[2] || "/Applications/Notion.app";
const finalDest = path.resolve(
  process.argv[3] || path.join(root, "dist/Notion 隐私锁.app"),
);
const scratch = path.resolve(
  process.env.NPL_BUILD_WORK_DIR || path.join(root, "work/build"),
);
const dest = path.join(
  scratch,
  "Notion-building-" + crypto.randomUUID() + ".app",
);
if (process.platform !== "darwin") throw Error("This build requires macOS.");
if (fs.existsSync(finalDest))
  throw Error("Output already exists. Choose a new output path.");
const originalAsar = path.join(original, "Contents/Resources/app.asar");
const pkg = JSON.parse(asar.extractFile(originalAsar, "package.json"));
if (pkg.version !== "7.33.0")
  throw Error(
    `Unsupported Notion version ${pkg.version}; expected 7.33.0. No changes made.`,
  );
fs.mkdirSync(scratch, { recursive: true });
const extracted = fs.mkdtempSync(path.join(scratch, "source-"));
asar.extractAll(originalAsar, extracted);
const src = path.join(extracted, "page-lock");
fs.cpSync(path.join(root, "src"), src, { recursive: true });
const main = path.join(extracted, ".webpack/main/index.js");
fs.writeFileSync(
  main,
  `require('../../page-lock/main.cjs');\n` +
    fs
      .readFileSync(main, "utf8")
      .replace("isAutoUpdaterDisabled:!1", "isAutoUpdaterDisabled:!0"),
);
const preload = path.join(
  extracted,
  ".webpack/renderer/tab_browser_view/preload.js",
);
if (!fs.existsSync(preload)) throw Error("Unknown preload layout.");
const originalPreload = fs.readFileSync(preload, "utf8");
const desktopFlag = 'a.contextBridge.exposeInMainWorld("__isElectron",!0)';
if (!originalPreload.includes(desktopFlag))
  throw Error("Unknown login bridge layout.");
const inlineLoginPreload = originalPreload.replace(
  desktopFlag,
  'a.contextBridge.exposeInMainWorld("__isElectron",!/^\\/login(?:\\/|$)/.test(location.pathname))',
);
fs.writeFileSync(
  preload,
  fs.readFileSync(path.join(src, "preload.js"), "utf8") +
    "\n" +
    inlineLoginPreload,
);
// Hard-disable updater checks for this explicitly version-pinned local copy.
let code = fs.readFileSync(main, "utf8");
const updateGuard =
  "function x(){const e=w.Store.getState().app.preferences?.isAutoUpdaterDisabled";
if (!code.includes(updateGuard))
  throw Error("Unknown updater layout; refusing to build.");
code = code.replace(
  updateGuard,
  "function x(){return true;const e=w.Store.getState().app.preferences?.isAutoUpdaterDisabled",
);
const nativeBridge =
  "t.initializeMeetingNotesExtensionNativeMessaging=async function(){";
if (!code.includes(nativeBridge))
  throw Error("Unknown native messaging layout; refusing to build.");
code = code.replace(nativeBridge, nativeBridge + "return;");
fs.writeFileSync(main, code);
execFileSync("/usr/bin/ditto", [original, dest]);
await asar.createPackageWithOptions(
  extracted,
  path.join(dest, "Contents/Resources/app.asar"),
  { unpack: "**/*.node" },
);
const header = asar.getRawHeader(
  path.join(dest, "Contents/Resources/app.asar"),
).headerString;
const hash = crypto.createHash("sha256").update(header).digest("hex");
const plist = path.join(dest, "Contents/Info.plist");
execFileSync("/usr/bin/plutil", [
  "-replace",
  "CFBundleIdentifier",
  "-string",
  "local.notion.page-lock",
  plist,
]);
// CFBundleName must stay Notion: Electron derives bundled Helper app names from it.
execFileSync("/usr/bin/plutil", [
  "-replace",
  "CFBundleDisplayName",
  "-string",
  "Notion 隐私锁",
  plist,
]);
execFileSync("/usr/bin/plutil", ["-remove", "CFBundleURLTypes", plist]);
execFileSync("/usr/bin/plutil", ["-remove", "ElectronTeamID", plist]);
execFileSync("/usr/bin/plutil", [
  "-replace",
  "ElectronAsarIntegrity",
  "-json",
  JSON.stringify({ "Resources/app.asar": { algorithm: "SHA256", hash } }),
  plist,
]);
const entitlements = path.join(scratch, "entitlements.plist");
installAppIcon(dest, scratch);
fs.writeFileSync(
  entitlements,
  '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.disable-library-validation</key><true/><key>com.apple.security.device.audio-input</key><true/><key>com.apple.security.device.camera</key><true/></dict></plist>',
);
execFileSync(
  "/usr/bin/codesign",
  [
    "--force",
    "--deep",
    "--sign",
    "-",
    "--options",
    "runtime",
    "--entitlements",
    entitlements,
    dest,
  ],
  { stdio: "inherit" },
);
execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", dest]);
fs.mkdirSync(path.dirname(finalDest), { recursive: true });
fs.renameSync(dest, finalDest);
console.log(`Built and signature-verified: ${finalDest}`);
