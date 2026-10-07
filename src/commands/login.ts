// Opens a real Chrome window on NUworks so you can sign in yourself
// (Northeastern SSO + Duo). NU Portal watches for your dashboard, saves the
// session right then, and closes the window. It never sees your password.

import { NUWORKS_URL } from "../config/paths.js";
import { logEvent } from "../core/events.js";
import { sleep } from "../core/util.js";
import { now, openDb, setKv } from "../db/db.js";
import { openBrowser, saveSessionState } from "../nuworks/browser.js";
import { looksSignedIn } from "../nuworks/session.js";

const TIMEOUT_MS = 15 * 60_000;

export default async function login(): Promise<number> {
  const db = openDb();
  const handle = await openBrowser({ headless: false, purpose: "the NUworks sign-in window" });
  let closedByUser = false;
  handle.context.on("close", () => (closedByUser = true));
  await handle.page.goto(NUWORKS_URL).catch(() => {});

  console.log(
    [
      "",
      "A Chrome window is open on NUworks.",
      "1. Sign in with your Northeastern credentials and approve Duo.",
      '   Tick "remember me" / "trust this browser" if offered; it makes the session last longer.',
      "2. That's it: when your NUworks dashboard appears, NU Portal saves your session and closes the window.",
      "",
    ].join("\n"),
  );

  // Signed in = a fully loaded NUworks page that isn't a sign-in page, three
  // checks in a row (redirects pass through NUworks pages for a moment).
  const deadline = Date.now() + TIMEOUT_MS;
  let streak = 0;
  while (!closedByUser && Date.now() < deadline && streak < 3) {
    await sleep(1000);
    let ok = false;
    for (const page of handle.context.pages()) {
      const loaded = await page.evaluate(() => document.readyState === "complete").catch(() => false);
      if (loaded && (await looksSignedIn(page).catch(() => false))) ok = true;
    }
    streak = ok ? streak + 1 : 0;
  }
  const signedIn = streak >= 3;

  if (signedIn && !closedByUser) {
    await sleep(2500); // let the last cookies land
    await saveSessionState(handle.context);
    setKv(db, "session.loginAt", now());
    logEvent(db, { kind: "session.login", message: "Signed in to NUworks; session saved" });
    console.log("Signed in. Session saved; closing the window.");
    await handle.close();
    return 0;
  }

  await handle.close();
  const why = closedByUser ? "The window was closed before your NUworks dashboard appeared." : "Timed out waiting for sign-in (15 minutes).";
  logEvent(db, { level: "warn", kind: "session.login_incomplete", message: why });
  console.log(`${why} Run Sign in to NUworks again and wait for your dashboard.`);
  return 1;
}
