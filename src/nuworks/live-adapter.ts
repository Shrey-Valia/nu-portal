import type { BrowserContext, Page } from "playwright";
import type { Settings } from "../config/settings.js";
import { humanDelay } from "../core/util.js";
import { AdapterNotReadyError, type ApplicationRow, type ApplicationsSnapshot, type NuworksAdapter, type Posting, type PostingSummary } from "./adapter.js";
import { JobDetail, JobList } from "./api-schemas.js";
import { toPosting } from "./map.js";

// Real NUworks reads, mapped during recon (docs/recon/nuworks-map.md).
// Job data comes from the site's own JSON API with your saved session: GET
// requests only, paced like a person. Your applications are read from the
// My Job Applications page.

export const NUWORKS_BASE = "https://northeastern-csm.symplicity.com";

export class NuworksSignedOutError extends Error {}

export interface LiveAdapterDeps {
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

export class LiveAdapter implements NuworksAdapter {
  readonly kind = "live";

  constructor(
    private readonly handle: LiveAdapterDeps,
    private readonly settings: Settings,
  ) {}

  private auth: string | null = null;

  // NUworks' API answers with empty results unless a request carries the
  // Authorization header its own web app adds. Load the Jobs page once and
  // reuse the header the app sends. Kept in memory only, never saved or logged.
  private async apiAuth(): Promise<string> {
    if (this.auth) return this.auth;
    const { context, page } = this.handle;
    const seen = new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => done(null), 30_000);
      const onRequest = (req: import("playwright").Request) => {
        if (!/\/api\/v[23]\//.test(req.url())) return;
        req.allHeaders().then((h) => h.authorization && done(h.authorization), () => {});
      };
      const done = (value: string | null) => {
        clearTimeout(timer);
        context.off("request", onRequest);
        resolve(value);
      };
      context.on("request", onRequest);
    });
    await page.goto(`${NUWORKS_BASE}/students/app/jobs/discover`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    if (/signin/i.test(page.url())) throw new NuworksSignedOutError("NUworks signed you out. Sign in again from Setup.");
    const auth = await seen;
    if (!auth) throw new Error("Couldn't get access to NUworks' job data (the Jobs page never called its API).");
    this.auth = auth;
    return auth;
  }

  private async getJson(path: string, params: Record<string, string> = {}): Promise<unknown> {
    // NUworks expects literal commas and "!" (e.g. job_type=5,17&sort=!postdate), so build the query by hand.
    const query = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v).replace(/%2C/gi, ",").replace(/%21/g, "!")}`)
      .join("&");
    const url = new URL(`${path}${query ? `?${query}` : ""}`, NUWORKS_BASE);
    const res = await this.handle.context.request.get(url.href, {
      headers: { Accept: "application/json, text/plain, */*", Authorization: await this.apiAuth(), "X-Requested-System-User": "students" },
      timeout: 45_000,
    });
    const type = res.headers()["content-type"] ?? "";
    if (res.status() === 401 || res.status() === 403 || (res.ok() && !type.includes("json"))) {
      throw new NuworksSignedOutError("NUworks signed you out. Sign in again from Setup.");
    }
    if (!res.ok()) throw new Error(`NUworks ${url.pathname} answered ${res.status()}`);
    const body = await res.json();
    await humanDelay(this.settings.pacing.actionDelayMs);
    return body;
  }

  async search(): Promise<PostingSummary[]> {
    const out: PostingSummary[] = [];
    const n = this.settings.nuworks;
    for (let page = 1; page <= n.maxPagesPerRun; page++) {
      const list = JobList.parse(
        await this.getJson("/api/v2/jobs", { ...n.searchParams, perPage: "20", page: String(page), sort: "!postdate", json_mode: "read_only", enable_translation: "false" }),
      );
      for (const m of list.models) {
        out.push({
          id: m.job_id,
          title: m.job_title.trim(),
          employer: (m.name ?? "").trim(),
          location: m.job_location ?? null,
          deadlineAt: listDate(m.deadline),
          postedAt: listDate(m.postdate),
        });
      }
      if (page * list.perPage >= list.total || !list.models.length) break;
    }
    return out;
  }

  async detail(id: string): Promise<Posting> {
    if (!/^[0-9a-f]{32}$/.test(id)) throw new Error(`Not a NUworks job id: ${id}`);
    return toPosting(JobDetail.parse(await this.getJson(`/api/v3/jobs/${id}`)));
  }

  // NUworks shows no cap counter; the number of applications listed is the count.
  async applications(): Promise<ApplicationsSnapshot> {
    const page = this.handle.page;
    await page.goto(`${NUWORKS_BASE}/students/app/jobs/applied?subtab=nocr`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    if (/signin/i.test(page.url())) throw new NuworksSignedOutError("NUworks signed you out. Sign in again from Setup.");
    const found = await page.getByText(/\d+ results? found/).first().textContent({ timeout: 10_000 }).catch(() => null);
    const total = found ? Number.parseInt(found, 10) : null;
    const rows: ApplicationRow[] = [];
    const links = page.locator('h2 a[href*="/jobs/detail/"]');
    for (let i = 0; i < (await links.count()); i++) {
      const link = links.nth(i);
      const href = (await link.getAttribute("href")) ?? "";
      const item = link.locator("xpath=ancestor::li[1]");
      const text = (await item.innerText().catch(() => "")) ?? "";
      rows.push({
        jobId: href.match(/\/jobs\/detail\/([0-9a-f]{32})/)?.[1] ?? href,
        title: (await link.innerText()).trim(),
        employer: ((await item.locator('p a[href*="/employers/"]').first().innerText().catch(() => "")) ?? "").trim(),
        appliedAt: text.match(/Application submitted ([^\n]+?)(?:\s{2,}|\n|$)/)?.[1]?.trim() ?? null,
        status: /withdrawn/i.test(text) ? "withdrawn" : "submitted",
      });
    }
    return { rows, capCount: total ?? rows.length, capShown: null };
  }

  async resumeStatus(): Promise<{ approved: boolean; name: null }> {
    throw new AdapterNotReadyError("Resume approval status isn't mapped yet (needed for NUworks applying, Phase 5).");
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}

// "Oct 16, 2026" -> "2026-10-16" (compared by date only; detail data has exact times)
export function listDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const d = new Date(`${s} 12:00`);
  return Number.isNaN(d.getTime()) ? null : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
