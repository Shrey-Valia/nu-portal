import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { ROOT } from "../config/paths.js";
import { execFileAsync } from "../core/util.js";

const APP = path.join(os.homedir(), "Applications", "NU Portal.app");

// npm run app -- install | uninstall
// Builds a small macOS app (an AppleScript applet) that runs `npm start`, so
// NU Portal opens from Launchpad, Spotlight, or the Dock like any other app.
export default async function app(argv: string[]): Promise<number> {
  const action = argv[0];
  if (action === "uninstall") {
    rmSync(APP, { recursive: true, force: true });
    console.log(`Removed ${APP}`);
    return 0;
  }
  if (action !== "install") {
    console.error("Usage: npm run app -- install|uninstall");
    return 2;
  }
  const q = (s: string) => `quoted form of "${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  const script = [
    "on run",
    `  do shell script "cd " & ${q(ROOT)} & " && " & ${q(process.execPath)} & " --disable-warning=ExperimentalWarning --import tsx src/cli.ts start >> data/logs/app.log 2>&1"`,
    "end run",
  ].join("\n");
  const tmp = mkdtempSync(path.join(os.tmpdir(), "nuportal-app-"));
  try {
    mkdirSync(path.join(ROOT, "data", "logs"), { recursive: true });
    mkdirSync(path.dirname(APP), { recursive: true });
    const src = path.join(tmp, "NU Portal.applescript");
    writeFileSync(src, script);
    rmSync(APP, { recursive: true, force: true });
    await execFileAsync("/usr/bin/osacompile", ["-o", APP, src]);
    const iconed = await makeIcon(tmp, path.join(APP, "Contents", "Resources", "applet.icns")).then(
      () => true,
      (err) => (console.warn(`(kept the default icon: ${(err as Error).message})`), false),
    );
    if (iconed) {
      // Newer macOS reads the icon from Assets.car via CFBundleIconName; drop both so applet.icns is used.
      await execFileAsync("/usr/libexec/PlistBuddy", ["-c", "Delete :CFBundleIconName", path.join(APP, "Contents", "Info.plist")]).catch(() => {});
      rmSync(path.join(APP, "Contents", "Resources", "Assets.car"), { force: true });
    }
    // Editing the bundle invalidates osacompile's signature; re-sign it for this Mac.
    await execFileAsync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", APP]).catch(() => {});
    await execFileAsync("/usr/bin/touch", [APP]); // nudge Finder to pick up the icon
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`Installed ${APP}`);
  console.log("Open it from Launchpad or Spotlight (\"NU Portal\"), or drag it to your Dock.");
  console.log("The first time, macOS may ask to let it access your Desktop folder; click Allow.");
  return 0;
}

// Draws the icon with Chrome, then builds an .icns with the macOS sips/iconutil tools.
async function makeIcon(tmp: string, out: string): Promise<void> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3f8a75"/><stop offset="1" stop-color="#1f4d41"/></linearGradient></defs>
    <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#g)"/>
    <path d="M300 690 L512 330 L724 690" fill="none" stroke="#e8f5f0" stroke-width="64" stroke-linecap="round" stroke-linejoin="round" opacity=".35"/>
    <text x="512" y="600" text-anchor="middle" font-family="-apple-system, Helvetica, Arial" font-weight="800" font-size="300" fill="#ffffff">NU</text>
    <rect x="352" y="680" width="320" height="34" rx="17" fill="#ffffff" opacity=".85"/>
  </svg>`;
  const png = path.join(tmp, "icon.png");
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
    await page.screenshot({ path: png, omitBackground: true });
  } finally {
    await browser.close();
  }
  const set = path.join(tmp, "icon.iconset");
  mkdirSync(set);
  for (const size of [16, 32, 128, 256, 512]) {
    await execFileAsync("/usr/bin/sips", ["-z", String(size), String(size), png, "--out", path.join(set, `icon_${size}x${size}.png`)]);
    await execFileAsync("/usr/bin/sips", ["-z", String(size * 2), String(size * 2), png, "--out", path.join(set, `icon_${size}x${size}@2x.png`)]);
  }
  const icns = path.join(tmp, "icon.icns");
  await execFileAsync("/usr/bin/iconutil", ["-c", "icns", set, "-o", icns]);
  if (!existsSync(path.dirname(out))) mkdirSync(path.dirname(out), { recursive: true });
  copyFileSync(icns, out);
}
