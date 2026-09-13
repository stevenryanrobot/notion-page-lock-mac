import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const asset = fileURLToPath(new URL("../assets/app-icon.png", import.meta.url));

// Run before signing the app. The distinct resource name avoids stale icon caches.
export function installAppIcon(bundle, scratch) {
  const temporary = fs.mkdtempSync(path.join(scratch, "orange-icon-"));
  const iconset = path.join(temporary, "AppIcon.iconset");
  fs.mkdirSync(iconset);
  try {
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        const name = `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`;
        execFileSync(
          "/usr/bin/sips",
          [
            "-z",
            String(size * scale),
            String(size * scale),
            asset,
            "--out",
            path.join(iconset, name),
          ],
          { stdio: "pipe" },
        );
      }
    }
    const resources = path.join(bundle, "Contents/Resources");
    execFileSync("/usr/bin/iconutil", [
      "-c",
      "icns",
      iconset,
      "-o",
      path.join(resources, "notion-page-lock-orange-rounded.icns"),
    ]);
    fs.copyFileSync(asset, path.join(resources, "icon-production.png"));
    const plist = path.join(bundle, "Contents/Info.plist");
    const info = JSON.parse(
      execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", plist], {
        encoding: "utf8",
      }),
    );
    // The vendor asset-catalog name takes precedence over CFBundleIconFile.
    // Remove that reference so macOS actually resolves our custom ICNS.
    if (Object.hasOwn(info, "CFBundleIconName")) {
      execFileSync("/usr/bin/plutil", ["-remove", "CFBundleIconName", plist]);
    }
    execFileSync("/usr/bin/plutil", [
      "-replace",
      "CFBundleIconFile",
      "-string",
      "notion-page-lock-orange-rounded.icns",
      plist,
    ]);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
