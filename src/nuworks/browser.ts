import { mkdirSync } from "node:fs";
import { type BrowserContext, chromium, type Page } from "playwright";
import { BROWSER_PROFILE_DIR, NUWORKS_HOSTS } from "../config/paths.js";
import { acquireLock } from "../core/lock.js";

export interface OpenBrowserOptions {
  headless?: boolean;
  // Blocks every non-GET request to NUworks, so a read-only run physically
  // cannot apply, upload, or change anything.
  readOnly?: boolean;
  // Paths of read-only POST endpoints found during recon (e.g. a search API).
  allowPost?: RegExp[];
}

export interface BrowserHandle {
  context: BrowserContext;
  page: Page;
  blocked: string[];
  close(): Promise<void>;
}

export async function openBrowser(opts: OpenBrowserOptions = {}): Promise<BrowserHandle> {
  const release = acquireLock("browser");
  try {
    mkdirSync(BROWSER_PROFILE_DIR, { recursive: true });
    const headless = opts.headless ?? true;
    const context = await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
      channel: "chrome",
      headless,
      viewport: headless ? { width: 1366, height: 900 } : null,
    });
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
