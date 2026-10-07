import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { BROWSER_PROFILE_DIR, DATA_DIR, NUWORKS_URL } from "../config/paths.js";
import { acquireLock } from "../core/lock.js";

export const CDP_PORT = 9222;

// Phase 2: opens your saved Chrome profile on NUworks with a local debugging
// port so Claude Code's Playwright / Chrome DevTools MCP servers can attach and
// read pages (the recon-* servers in .mcp.json). NUworks traffic is recorded to
// data/recon/ (gitignored; it contains your session). You do every click that
// could change something; MCP clicks ask for your approval first.
export default async function recon(): Promise<number> {
  const release = acquireLock("browser", "the NUworks recon window");
  const dir = path.join(DATA_DIR, "recon");
  mkdirSync(dir, { recursive: true });
  const har = path.join(dir, `nuworks-${new Date().toISOString().replace(/[:.]/g, "-")}.har`);
  const context = await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
    channel: "chrome",
    headless: false,
    viewport: null,
    args: [`--remote-debugging-port=${CDP_PORT}`, "--remote-debugging-address=127.0.0.1"],
    recordHar: { path: har, urlFilter: /nuworks\.northeastern\.edu|symplicity\.com/, content: "embed" },
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(NUWORKS_URL);
  console.log(
    [
      "",
      `Recon browser is open (debugging on 127.0.0.1:${CDP_PORT}).`,
      "1. Sign in if asked.",
      "2. In Claude Code, run /recon. Claude attaches with the recon-playwright / recon-devtools MCP servers.",
      "3. Do the state-changing clicks yourself when Claude asks (e.g. open Apply, then Cancel). Never submit.",
      "4. Close the window when done.",
      `Network log: ${har}`,
      "",
    ].join("\n"),
  );
  await context.waitForEvent("close", { timeout: 0 });
  await context.close().catch(() => {});
  release();
  console.log(`Saved ${har}`);
  return 0;
}
