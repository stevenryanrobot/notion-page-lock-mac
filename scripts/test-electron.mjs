import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import * as asar from "@electron/asar";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const work = path.resolve(
  process.env.NPL_TEST_WORK_DIR || path.join(root, "work/tests"),
);
fs.mkdirSync(work, { recursive: true });
const stage = fs.mkdtempSync(path.join(work, "electron-fixture-"));
const src = path.join(stage, "source");
fs.mkdirSync(src);
fs.cpSync(path.join(root, "src"), path.join(src, "page-lock"), {
  recursive: true,
});
fs.mkdirSync(path.join(src, "tab_browser_view"));
fs.copyFileSync(
  path.join(root, "src/preload.js"),
  path.join(src, "tab_browser_view/preload.js"),
);
fs.copyFileSync(
  path.join(root, "tests/electron-harness.cjs"),
  path.join(src, "main.cjs"),
);
fs.writeFileSync(
  path.join(src, "package.json"),
  JSON.stringify({ name: "Notion", version: "0.1.0", main: "main.cjs" }),
);
const dest = path.join(stage, "Notion Test.app");
execFileSync("/usr/bin/ditto", ["/Applications/Notion.app", dest]);
const archive = path.join(dest, "Contents/Resources/app.asar");
await asar.createPackage(src, archive);
const hash = crypto
  .createHash("sha256")
  .update(asar.getRawHeader(archive).headerString)
  .digest("hex");
const plist = path.join(dest, "Contents/Info.plist");
for (const key of ["CFBundleURLTypes", "ElectronTeamID"])
  execFileSync("/usr/bin/plutil", ["-remove", key, plist]);
execFileSync("/usr/bin/plutil", [
  "-replace",
  "CFBundleIdentifier",
  "-string",
  "local.notion.page-lock.tests",
  plist,
]);
execFileSync("/usr/bin/plutil", [
  "-replace",
  "ElectronAsarIntegrity",
  "-json",
  JSON.stringify({ "Resources/app.asar": { algorithm: "SHA256", hash } }),
  plist,
]);
const entitlements = path.join(stage, "entitlements.plist");
fs.writeFileSync(
  entitlements,
  '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.disable-library-validation</key><true/></dict></plist>',
);
execFileSync("/usr/bin/codesign", [
  "--force",
  "--deep",
  "--sign",
  "-",
  "--options",
  "runtime",
  "--entitlements",
  entitlements,
  dest,
]);
const output = path.join(stage, "results");
const result = spawnSync(path.join(dest, "Contents/MacOS/Notion"), [], {
  env: { ...process.env, NPL_HARNESS_OUTPUT: output },
  timeout: 60000,
  killSignal: "SIGKILL",
  encoding: "utf8",
});
console.log(result.stdout);
console.log(result.stderr);
const report = path.join(output, "electron-results.json");
let passed = false;
if (fs.existsSync(report)) {
  const body = fs.readFileSync(report, "utf8");
  console.log(body);
  passed = JSON.parse(body).passed === true;
}
console.log("Fixture artifacts:", output);
process.exitCode = result.status === 0 && passed ? 0 : 1;
