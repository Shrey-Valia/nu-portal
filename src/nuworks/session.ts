import { NUWORKS_HOSTS, NUWORKS_URL } from "../config/paths.js";
import { type Db, now, setKv } from "../db/db.js";
import { logEvent } from "../core/events.js";
import { type BrowserHandle, openBrowser } from "./browser.js";
import { SESSION } from "./selectors.js";

export type SessionStatus = "ok" | "sso_silent_ok" | "needs_login" | "error";

export interface SessionResult {
  status: SessionStatus;
  finalUrl: string;
  detail: string;
  checkedAt: string;
}

const hostOf = (u: string) => {
  try {
    return new URL(u).hostname;
  } catch {
    return "";
  }
};

// Opens NUworks with the saved profile and decides whether you're still signed in.
// Never touches a login form: if a sign-in page appears, the answer is "needs_login".
export async function checkSession(db: Db | null, existing?: BrowserHandle): Promise<SessionResult> {
  const handle = existing ?? (await openBrowser({ headless: true, readOnly: true }));
  const hops: string[] = [];
  const onNav = (frame: { url(): string; parentFrame(): unknown }) => {
    if (!frame.parentFrame()) hops.push(frame.url());
  };
  handle.page.on("framenavigated", onNav);
  let result: SessionResult;
  try {
    await handle.page.goto(NUWORKS_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await handle.page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    const finalUrl = handle.page.url();
    const onNuworks = NUWORKS_HOSTS.includes(hostOf(finalUrl));
    const leftNuworks = hops.some((u) => u.startsWith("http") && !NUWORKS_HOSTS.includes(hostOf(u)));
    const loginMarkers = await handle.page.locator(SESSION.loginMarker).count();
    const loggedInMarkers = SESSION.loggedInMarker ? await handle.page.locator(SESSION.loggedInMarker).count() : 0;
    const loginUrl = SESSION.loginUrlPattern.test(finalUrl);

    if (onNuworks && !loginUrl && loginMarkers === 0 && (SESSION.loggedInMarker ? loggedInMarkers > 0 : true)) {
      result = {
        status: leftNuworks ? "sso_silent_ok" : "ok",
        finalUrl,
        detail: leftNuworks ? "Signed in again silently through Northeastern SSO" : "Signed in",
        checkedAt: now(),
      };
    } else {
      result = { status: "needs_login", finalUrl, detail: "A sign-in page appeared. Run: npm run login", checkedAt: now() };
    }
  } catch (err) {
    result = { status: "error", finalUrl: handle.page.url(), detail: (err as Error).message, checkedAt: now() };
  } finally {
    handle.page.off("framenavigated", onNav);
    if (!existing) await handle.close();
  }
  if (db) {
    setKv(db, "session", result);
    if (result.status === "ok" || result.status === "sso_silent_ok") setKv(db, "session.lastOkAt", result.checkedAt);
    logEvent(db, {
      level: result.status === "needs_login" || result.status === "error" ? "warn" : "info",
      kind: "session.check",
      message: `${result.status}: ${result.detail}`,
      data: { finalUrl: result.finalUrl },
    });
  }
  return result;
}
