import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type BrowserContext, chromium, type Page } from "playwright";
import { AUTH_DIR, BROWSER_PROFILE_DIR, NUWORKS_HOSTS } from "../config/paths.js";
import { acquireLock } from "../core/lock.js";

export interface OpenBrowserOptions {
  headless?: boolean;
  // Blocks every non-GET request to NUworks, so a read-only run physically
  // cannot apply, upload, or change anything.
  readOnly?: boolean;
  // Paths of read-only POST endpoints found during recon (e.g. a search API).
  allowPost?: RegExp[];
  // What's using the browser, shown to anything blocked behind it.
  purpose?: string;
}

export interface BrowserHandle {
  context: BrowserContext;
  page: Page;
  blocked: string[];
  close(): Promise<void>;
}

export async function openBrowser(opts: OpenBrowserOptions = {}): Promise<BrowserHandle> {
  const release = acquireLock("browser", opts.purpose ?? (opts.headless === false ? "an NU Portal Chrome window" : "an NUworks check"));
  try {
    mkdirSync(BROWSER_PROFILE_DIR, { recursive: true });
    const headless = opts.headless ?? true;
    const context = await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
      channel: "chrome",
      headless,
      viewport: headless ? { width: 1366, height: 900 } : null,
    });
    await restoreSessionState(context);
    const blocked: string[] = [];
    if (opts.readOnly) await installReadOnlyGuard(context, blocked, opts.allowPost ?? []);
    const page = context.pages()[0] ?? (await context.newPage());
    return {
      context,
      page,
      blocked,
      async close() {
        await context.close().catch(() => {});
        release();
      },
    };
  } catch (err) {
    release();
    throw err;
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

async function installReadOnlyGuard(context: BrowserContext, blocked: string[], allowPost: RegExp[]): Promise<void> {
  await context.route(
    (url) => NUWORKS_HOSTS.includes(url.hostname),
    async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (SAFE_METHODS.has(req.method()) || allowPost.some((re) => re.test(url.pathname))) {
        return route.continue();
      }
      blocked.push(`${req.method()} ${url.pathname}`);
      return route.abort("blockedbyclient");
    },
  );
}

// Chrome throws away cookies that have no expiry date when it closes, and
// NUworks' login cookies are like that. Sign-in saves them here the moment your
// dashboard appears; every later run puts them back. Same sensitivity as the
// Chrome profile itself: gitignored, owner-only.
const STATE_FILE = path.join(AUTH_DIR, "nuworks-session.json");

export async function saveSessionState(context: BrowserContext): Promise<void> {
  mkdirSync(AUTH_DIR, { recursive: true });
  const state = await context.storageState();
  writeFileSync(STATE_FILE, JSON.stringify({ savedAt: new Date().toISOString(), cookies: state.cookies }));
  chmodSync(STATE_FILE, 0o600);
}

export async function restoreSessionState(context: BrowserContext): Promise<void> {
  if (!existsSync(STATE_FILE)) return;
  try {
    const { cookies } = JSON.parse(readFileSync(STATE_FILE, "utf8")) as { cookies: Parameters<BrowserContext["addCookies"]>[0] };
    const nowSec = Date.now() / 1000;
    await context.addCookies(cookies.filter((c) => !c.expires || c.expires < 0 || c.expires > nowSec));
  } catch {
    /* a bad state file just means signing in again */
  }
}
