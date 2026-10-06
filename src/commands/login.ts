// Opens a real Chrome window on NUworks so you can sign in yourself
// (Northeastern SSO + Duo). The session is saved to .auth/browser-profile and
// reused by later steps, so NU Portal never sees or stores your password.

import { NUWORKS_URL } from "../config/paths.js";
import { openDb, setKv, now } from "../db/db.js";
import { logEvent } from "../core/events.js";
import { openBrowser } from "../nuworks/browser.js";

export default async function login(): Promise<number> {
  const db = openDb();
  const handle = await openBrowser({ headless: false });
  await handle.page.goto(NUWORKS_URL);

  console.log(
    [
      "",
      "A Chrome window is open on NUworks.",
      "1. Sign in with your Northeastern credentials and approve Duo.",
      '   Tick "remember me" / "trust this browser" if offered; it makes the session last longer.',
      "2. Wait until you see your NUworks student dashboard.",
      "3. Close the Chrome window. Your session is saved to .auth/browser-profile.",
      "",
    ].join("\n"),
  );

  await handle.context.waitForEvent("close", { timeout: 0 });
  await handle.close();
  setKv(db, "session.loginAt", now());
  logEvent(db, { kind: "session.login", message: "Manual login window closed" });
  console.log("Session saved. Check it any time with: npm run session:check");
  return 0;
}
