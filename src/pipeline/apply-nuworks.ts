import path from "node:path";
import type { Locator, Page } from "playwright";
import { SCREENSHOTS_DIR } from "../config/paths.js";
import type { Settings } from "../config/settings.js";
import { logEvent, transition } from "../core/events.js";
import { haltInfo } from "../core/halt.js";
import { humanDelay, randomBetween, sleep } from "../core/util.js";
import { type Db, getKv, json, now, setKv } from "../db/db.js";
import { getJob, type JobRow } from "../jobs/store.js";
import { openBrowser } from "../nuworks/browser.js";
import { LiveAdapter, NuworksSignedOutError, nuworksJobUrl } from "../nuworks/live-adapter.js";
import { checkSession } from "../nuworks/session.js";
import type { Mode } from "./apply-external.js";
import { ensureCycle, nuworksBudgetNow } from "./nuworks.js";

// Applies to the NUworks jobs you approved, using the Apply dialog mapped in
// recon (docs/recon/nuworks-map.md): pick your approved default resume, Submit,
// then confirm through the API that NUworks shows the job as applied.
//   dry-run: opens the dialog, screenshots, Cancels. Nothing is sent.
//   live:    submits. The first 3 pause for your Submit click in the app.

export const NUWORKS_GRADUATION = 3;
export const nuworksCleanSubmits = (db: Db) => getKv<number>(db, "nuworks.cleanSubmits", 0);

export interface ApplyNuworksOptions {
  mode: Mode;
  unattended: boolean;
  headed?: boolean;
  max?: number;
  jobIds?: string[];
  confirm?: (summary: string, screenshot: string) => Promise<boolean>;
  runId: number;
}

export interface NuworksOutcome {
  jobId: string;
  result: "submitted" | "submit_unknown" | "needs_manual" | "dry_run_ok" | "skipped" | "already_applied" | "expired";
  detail: string;
}

// "Finish on the employer's site" items: NUworks part done, outside link still to do.
export interface FollowUp {
  jobId: string;
  title: string;
  employer: string;
  url: string;
  at: string;
}
export const followUps = (db: Db) => getKv<FollowUp[]>(db, "followups", []);
export function addFollowUp(db: Db, f: FollowUp): void {
  setKv(db, "followups", [...followUps(db).filter((x) => x.jobId !== f.jobId), f]);
}
export function doneFollowUp(db: Db, jobId: string): boolean {
  const list = followUps(db);
  setKv(db, "followups", list.filter((x) => x.jobId !== jobId));
  return list.some((x) => x.jobId === jobId);
}

export async function applyNuworks(db: Db, s: Settings, opts: ApplyNuworksOptions): Promise<NuworksOutcome[]> {
  if (haltInfo(db)) throw new Error("Applying is halted (offer accepted). Clear it with: npm run offer -- clear");
  const live = opts.mode === "live";
  const supervised = nuworksCleanSubmits(db) < NUWORKS_GRADUATION;
  if (live && supervised && (opts.unattended || !opts.confirm)) {
    throw new Error(`NUworks applying needs ${NUWORKS_GRADUATION - nuworksCleanSubmits(db)} more supervised submit(s): use "Apply for real" in the app.`);
  }
  const all = opts.jobIds?.length
    ? opts.jobIds.map((id) => getJob(db, id)).filter((j): j is JobRow => !!j)
    : (db.prepare("SELECT * FROM jobs WHERE status = 'approved' AND source = 'nuworks' AND apply_method != 'external' ORDER BY deadline_at IS NULL, deadline_at").all() as unknown as JobRow[]);
  const jobs = all.filter((j) => j.status === "approved" && j.source === "nuworks").slice(0, opts.max ?? undefined);
  const outcomes: NuworksOutcome[] = [];
  if (!jobs.length) return outcomes;

  // Read-only guard on for practice runs: nothing can be submitted.
  const handle = await openBrowser({ headless: !(opts.headed ?? false), readOnly: !live, purpose: live ? "a NUworks apply run" : "a NUworks practice run" });
  try {
    const session = await checkSession(db, handle);
    if (session.status !== "ok" && session.status !== "sso_silent_ok") throw new NuworksSignedOutError("NUworks needs you to sign in again (Setup → Sign in to NUworks).");
    const api = new LiveAdapter(handle, s);
    for (const [i, job] of jobs.entries()) {
      if (haltInfo(db)) break;
      if (live) {
        const b = nuworksBudgetNow(db, s);
        if (b.used >= s.cycle.cap) {
          outcomes.push({ jobId: job.id, result: "skipped", detail: `cycle cap of ${s.cycle.cap} reached` });
          break;
        }
        const weekUsed = s.nuworks.weeklyLimit - b.weekRemaining - Number((db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE source = 'nuworks' AND status IN ('approved', 'submitting')").get() as { n: number }).n);
        if (weekUsed >= s.nuworks.weeklyLimit) {
          outcomes.push({ jobId: job.id, result: "skipped", detail: `weekly limit of ${s.nuworks.weeklyLimit} reached; the rest wait for next week` });
          break;
        }
      }
      const outcome = await applyOne(db, s, handle.page, api, job, opts, supervised);
      outcomes.push(outcome);
      logEvent(db, { runId: opts.runId, jobId: job.id, level: outcome.result === "needs_manual" || outcome.result === "submit_unknown" ? "warn" : "info", kind: `nuworks.apply.${outcome.result}`, message: `${job.employer} — ${job.title}: ${outcome.detail}` });
      if (i < jobs.length - 1 && outcome.result !== "skipped") await sleep(live ? randomBetween(s.pacing.nuworksBetweenAppsMs) : 1500);
    }
  } finally {
    await handle.close();
  }
  return outcomes;
}

async function applyOne(db: Db, s: Settings, page: Page, api: LiveAdapter, job: JobRow, opts: ApplyNuworksOptions, supervised: boolean): Promise<NuworksOutcome> {
  const live = opts.mode === "live";
  const id = job.source_job_id ?? job.id.replace(/^nuworks:/, "");
  const manual = (detail: string): NuworksOutcome => {
    if (live) transition(db, job.id, "needs_manual", detail, opts.runId);
    return { jobId: job.id, result: live ? "needs_manual" : "dry_run_ok", detail: live ? detail : `would need you: ${detail}` };
  };

  // Fresh status from NUworks first: already applied, or closed?
  const before = await api.detail(id);
  const raw = before.raw as { applied?: boolean; expired?: boolean };
  if (raw.applied) {
    if (live) recordApplied(db, job, "tool", "already applied in NUworks", opts.runId, [], "applied_manual");
    return { jobId: job.id, result: "already_applied", detail: "NUworks already shows this as applied" };
  }
  if (raw.expired) {
    if (live) transition(db, job.id, "expired", "closed on NUworks", opts.runId);
    return { jobId: job.id, result: "expired", detail: "the posting has closed" };
  }

  await page.goto(nuworksJobUrl(id), { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  const applyBtn = page.getByRole("button", { name: /^apply$/i }).first();
  if (!(await applyBtn.isVisible().catch(() => false))) return manual("no Apply button on the posting");
  await humanDelay(s.pacing.actionDelayMs);
  await applyBtn.click();
  const dialog = page.getByRole("dialog").filter({ hasText: /Submit Your Application/i });
  try {
    await dialog.waitFor({ state: "visible", timeout: 20_000 });
  } catch {
    return manual("the Apply form didn't open");
  }

  // Variant 2: "How to Apply" panel with an outside link.
  const howTo = (await dialog.getByText(/How to Apply/i).count()) > 0;
  const externalUrl = howTo ? await firstOutsideLink(dialog) : null;

  // The dialog appears before NUworks draws its fields; wait for the dropdowns.
  await dialog.getByRole("combobox").first().waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  // Read the form the way recon did: from its accessibility tree ('combobox "Resume *"').
  const tree = await dialog.ariaSnapshot({ timeout: 10_000 });
  const comboboxes = [...tree.matchAll(/combobox "([^"]+)"/g)].map((m) => m[1]);
  const questions = [...tree.matchAll(/(?:textbox|checkbox|radio|spinbutton)(?: "([^"]*)")?/g)].map((m) => m[1] ?? "a question");
  let resumeLabel: string | null = null;
  for (const name of comboboxes) {
    if (/resume/i.test(name)) {
      resumeLabel = await chooseResume(dialog.getByRole("combobox", { name, exact: true }));
      if (!resumeLabel) return manual("no approved resume to choose in the Apply form");
    } else if (/cover letter/i.test(name)) {
      if (/\*/.test(name)) return manual("this posting requires a cover letter: attach your letter in NUworks (its PDF is on the job's page)");
    } else if (/\*/.test(name)) {
      return manual(`the Apply form asks for "${name.replace(/\s*\*$/, "")}"`);
    }
  }
  if (!resumeLabel) return manual("couldn't find the Resume dropdown");
  if (questions.length) return manual(`the Apply form has extra questions (${questions.slice(0, 3).join(", ")})`);

  const shot = path.join(SCREENSHOTS_DIR, `${job.id.replace(/[^a-z0-9]+/gi, "_")}-${Date.now()}-nuworks.png`);
  await page.screenshot({ path: shot, fullPage: false });

  if (!live) {
    await dialog.getByRole("button", { name: /^cancel$/i }).click().catch(() => page.keyboard.press("Escape"));
    return { jobId: job.id, result: "dry_run_ok", detail: `would submit with resume "${resumeLabel}"${externalUrl ? `, then you finish at ${externalUrl}` : ""} (nothing sent)` };
  }

  if (supervised) {
    const ok = await opts.confirm!(`${job.employer}: ${job.title}\nNUworks application with your resume "${resumeLabel}"${externalUrl ? `\nThe employer also wants you to apply at ${externalUrl} (added to your to-do list)` : ""}`, shot);
    if (!ok) {
      await dialog.getByRole("button", { name: /^cancel$/i }).click().catch(() => page.keyboard.press("Escape"));
      return { jobId: job.id, result: "skipped", detail: "you chose not to submit" };
    }
  }

  transition(db, job.id, "submitting", undefined, opts.runId);
  db.prepare("INSERT OR IGNORE INTO applications (job_id, track, cycle_id, via, result, started_at, screenshots) VALUES (?, 'nuworks', ?, 'tool', 'submitting', ?, ?)").run(job.id, ensureCycle(db, s), now(), json([shot]));
  await humanDelay(s.pacing.actionDelayMs);
  await dialog.getByRole("button", { name: /^submit$/i }).click();
  await dialog.waitFor({ state: "hidden", timeout: 20_000 }).catch(() => {});

  // NUworks' own record is the proof.
  let applied = false;
  for (let tries = 0; tries < 5 && !applied; tries++) {
    await sleep(2000);
    applied = Boolean(((await api.detail(id).catch(() => null))?.raw as { applied?: boolean } | undefined)?.applied);
  }
  const after = path.join(SCREENSHOTS_DIR, `${job.id.replace(/[^a-z0-9]+/gi, "_")}-${Date.now()}-nuworks-after.png`);
  await page.screenshot({ path: after }).catch(() => {});
  if (!applied) {
    db.prepare("UPDATE applications SET result = 'submit_unknown', error = ?, screenshots = ? WHERE job_id = ?").run("NUworks didn't show it as applied", json([shot, after]), job.id);
    transition(db, job.id, "submit_unknown", "clicked Submit but NUworks doesn't show it as applied yet", opts.runId);
    setKv(db, "nuworks.cleanSubmits", 0);
    return { jobId: job.id, result: "submit_unknown", detail: "clicked Submit; NUworks doesn't show it as applied yet (checked again on the next sync)" };
  }
  recordApplied(db, job, "tool", `submitted with resume "${resumeLabel}"`, opts.runId, [shot, after], "submitted");
  if (supervised) setKv(db, "nuworks.cleanSubmits", nuworksCleanSubmits(db) + 1);
  if (externalUrl) addFollowUp(db, { jobId: job.id, title: job.title, employer: job.employer, url: externalUrl, at: now() });
  return { jobId: job.id, result: "submitted", detail: `submitted with resume "${resumeLabel}"${externalUrl ? `; finish at ${externalUrl}` : ""}` };
}

function recordApplied(db: Db, job: JobRow, via: "tool" | "manual", reason: string, runId: number, shots: string[], to: "submitted" | "applied_manual"): void {
  const exists = db.prepare("SELECT id FROM applications WHERE job_id = ?").get(job.id);
  if (exists) db.prepare("UPDATE applications SET result = 'submitted', submitted_at = ?, screenshots = COALESCE(?, screenshots) WHERE job_id = ?").run(now(), shots.length ? json(shots) : null, job.id);
  else db.prepare("INSERT INTO applications (job_id, track, via, result, started_at, submitted_at, screenshots) VALUES (?, 'nuworks', ?, 'submitted', ?, ?, ?)").run(job.id, via, now(), now(), json(shots));
  transition(db, job.id, to, reason, runId);
}

// Keeps NUworks' preselected approved resume; otherwise the first real option.
async function chooseResume(sel: Locator): Promise<string | null> {
  const current = (await sel.evaluate((el) => {
    const s = el as HTMLSelectElement;
    return s.selectedIndex >= 0 ? (s.options[s.selectedIndex]?.text ?? "").trim() : "";
  })) as string;
  if (current) return current;
  const options = (await sel.locator("option").allInnerTexts()).map((t) => t.trim()).filter(Boolean);
  if (!options.length) return null;
  await sel.selectOption({ label: options[0] });
  return options[0];
}

async function firstOutsideLink(dialog: Locator): Promise<string | null> {
  const hrefs = await dialog.locator("a[href^='http']").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href));
  return hrefs.find((h) => !/symplicity\.com|northeastern\.edu/.test(h)) ?? null;
}
