// Opens a real Chrome window on NUworks so you can sign in yourself
// (Northeastern SSO + Duo). The session is saved to .auth/browser-profile
// and reused by later steps, so the tool never sees or stores your password.

import { chromium } from "playwright";
import { BROWSER_PROFILE_DIR, NUWORKS_URL } from "./config.js";

const context = await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
  channel: "chrome",
  headless: false,
  viewport: null,
});

const page = context.pages()[0] ?? (await context.newPage());
await page.goto(NUWORKS_URL);

console.log(
  [
    "",
    "A Chrome window is open on NUworks.",
    "1. Sign in with your Northeastern credentials and approve Duo.",
    "2. Wait until you see your NUworks student dashboard.",
    "3. Close the Chrome window. Your session is saved to .auth/browser-profile.",
    "",
  ].join("\n"),
);

await context.waitForEvent("close", { timeout: 0 });
console.log("Session saved.");
