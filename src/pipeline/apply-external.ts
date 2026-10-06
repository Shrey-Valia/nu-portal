import path from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { adapterFor, type DescribingAdapter } from "../ats/index.js";
import { standardFillPlan } from "../ats/standard-values.js";
import type { ApplyForm, AtsKind, FillPlan, FormField } from "../ats/types.js";
import { ChoiceAnswer, choiceAnswerPrompt } from "../brain/prompts/answer.js";
import { type Brain, BrainUnavailableError } from "../brain/types.js";
import { LETTERS_DIR, SCREENSHOTS_DIR } from "../config/paths.js";
import type { Settings } from "../config/settings.js";
import { externalRemainingToday } from "../core/budget.js";
import { logEvent, transition } from "../core/events.js";
import { haltInfo } from "../core/halt.js";
import { sanitizePosting } from "../core/sanitize.js";
import { localDay, startOfLocalDay } from "../core/time.js";
import { humanDelay, randomBetween, sleep } from "../core/util.js";
import { type Db, getKv, json, now, setKv } from "../db/db.js";
import { renderPdf } from "../letters/render-pdf.js";
import { letterHtml } from "../letters/template.js";
import { getJob, type JobRow } from "../jobs/store.js";
import { loadPrivate, type Me } from "../me/load.js";
import type { PrivateInfo } from "../me/schema.js";
import { answerFromBank, pickOption } from "../writing/answer-bank.js";
import { writeAnswer, writeCoverLetter } from "../writing/compose.js";
import { toPrompt } from "./nuworks.js";

// Applies to approved postings on Greenhouse / Lever / Ashby.
//   dry-run:  open, fill, screenshot, stop. Nothing is sent.
//   live:     also submits. Each adapter must pass 3 supervised (watched,
//             confirmed) submissions before it may run unattended.

export type Mode = "dry-run" | "rehearsal" | "live";
export const GRADUATION = 3;

export interface ApplyExternalOptions {
  mode: Mode;
  unattended: boolean; // true only for the launchd schedule
  headed?: boolean;
  max?: number;
  jobIds?: string[];
  // Asked before each supervised live submit. Absent = supervised jobs are skipped.
  confirm?: (summary: string, screenshot: string) => Promise<boolean>;
  runId: number;
  resolveAdapter?: (url: string) => DescribingAdapter | null; // tests point adapters at local fixtures
}

export interface ApplyOutcome {
  jobId: string;
  result: "submitted" | "submit_unknown" | "needs_manual" | "dry_run_ok" | "skipped";
  detail: string;
}

export const cleanSubmits = (db: Db, ats: AtsKind) => getKv<number>(db, `ats.${ats}.cleanSubmits`, 0);

export async function applyExternal(db: Db, brain: Brain, me: Me, s: Settings, opts: ApplyExternalOptions): Promise<ApplyOutcome[]> {
  if (haltInfo(db)) throw new Error("Applying is halted (offer accepted). Clear it with: npm run offer -- clear");
  const priv = loadPrivate();
  if (!me.files.resume) throw new Error("me/resume.pdf is missing; external applications need it.");

  const todayStart = startOfLocalDay(localDay(new Date(), s.timezone), s.timezone).toISOString();
  const submittedToday = Number((db.prepare("SELECT COUNT(*) AS n FROM applications WHERE track = 'external' AND via = 'tool' AND started_at >= ?").get(todayStart) as { n: number }).n);
  let remaining = opts.mode === "live" ? externalRemainingToday(s.external.maxPerDay, submittedToday) : Number.POSITIVE_INFINITY;
  const limit = Math.min(opts.max ?? Number.POSITIVE_INFINITY, remaining);

  const jobs = (opts.jobIds?.length ? opts.jobIds.map((id) => getJob(db, id)).filter((j): j is JobRow => !!j) : (db.prepare("SELECT * FROM jobs WHERE status = 'approved' AND apply_method = 'external' ORDER BY updated_at").all() as unknown as JobRow[]))
    .filter((j) => j.status === "approved" && j.apply_url)
    .slice(0, Number.isFinite(limit) ? limit : undefined);

  const outcomes: ApplyOutcome[] = [];
  if (!jobs.length) return outcomes;
  const browser = await chromium.launch({ channel: "chrome", headless: !opts.headed });
  try {
    for (const [i, job] of jobs.entries()) {
      if (haltInfo(db)) break; // kill switch pressed mid-run
      if (opts.mode === "live" && remaining <= 0) break;
      const outcome = await applyOne(db, brain, me, priv, s, browser, job, opts);
      outcomes.push(outcome);
      logEvent(db, { runId: opts.runId, jobId: job.id, level: outcome.result === "needs_manual" ? "warn" : "info", kind: `apply.${outcome.result}`, message: `${job.employer} — ${job.title}: ${outcome.detail}` });
      if (outcome.result === "submitted" || outcome.result === "submit_unknown") remaining--;
      if (i < jobs.length - 1 && outcome.result !== "skipped") await sleep(opts.mode === "live" ? randomBetween(s.pacing.externalBetweenAppsMs) : 1500);
    }
  } finally {
    await browser.close();
  }
  return outcomes;
}

async function applyOne(db: Db, brain: Brain, me: Me, priv: PrivateInfo, s: Settings, browser: Browser, job: JobRow, opts: ApplyExternalOptions): Promise<ApplyOutcome> {
  const pace = opts.mode === "live" ? s.pacing.actionDelayMs : ([150, 400] as const);
  const adapter = opts.resolveAdapter ? opts.resolveAdapter(job.apply_url!) : adapterFor(job.apply_url!, { delay: () => humanDelay(pace) });
  const manual = (detail: string): ApplyOutcome => {
    if (opts.mode === "live") transition(db, job.id, "needs_manual", detail, opts.runId);
    return { jobId: job.id, result: opts.mode === "live" ? "needs_manual" : "dry_run_ok", detail: opts.mode === "live" ? detail : `would need you: ${detail}` };
  };
  if (!adapter) return manual(`no adapter for ${job.ats ?? "this site"}`);

  const configured = (s.external.adapters as Record<string, string>)[adapter.kind] ?? "off";
  const graduated = cleanSubmits(db, adapter.kind) >= GRADUATION;
  const supervised = configured !== "auto" || !graduated;
  if (opts.mode === "live" && configured === "off") return manual(`${adapter.kind} adapter is off in settings`);
  if (opts.mode === "live" && supervised && (opts.unattended || !opts.confirm)) {
    return { jobId: job.id, result: "skipped", detail: `${adapter.kind} needs supervised runs first (${cleanSubmits(db, adapter.kind)}/${GRADUATION} done)` };
  }

  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await context.newPage();
  try {
    const form = await adapter.open(page, job.apply_url!);
    if (form.hasCaptcha) return manual("CAPTCHA on the form");
    if (form.blockers.length) return manual(form.blockers.join("; "));

    if (!job.description) {
      const text = sanitizePosting(await page.locator("body").innerText().catch(() => ""), 8000);
      db.prepare("UPDATE jobs SET description = ? WHERE id = ?").run(text, job.id);
      job.description = text;
    }

    const prep = await buildPlan(db, brain, me, priv, s, job, form, opts.runId);
    if (prep.blockers.length) return manual(prep.blockers.join("; "));

    const fill = await fillWithFollowUps(db, brain, me, priv, s, job, adapter, page, form, prep, opts.runId);
    if (fill.blockers.length) return manual(fill.blockers.join("; "));

    const shot = await screenshot(page, job.id, "filled");
    if (opts.mode !== "live") return { jobId: job.id, result: "dry_run_ok", detail: `filled ${fill.filled} fields, nothing sent (${path.basename(shot)})` };

    if (supervised) {
      const ok = await opts.confirm!(`${job.employer} — ${job.title}\n${fill.filled} fields filled${prep.letterId ? ", cover letter attached" : ""}${prep.answers.length ? `, ${prep.answers.length} written answers` : ""}`, shot);
      if (!ok) return { jobId: job.id, result: "skipped", detail: "you chose not to submit" };
    }

    transition(db, job.id, "submitting", undefined, opts.runId);
    db.prepare("INSERT INTO applications (job_id, track, via, result, letter_id, answers, screenshots, started_at) VALUES (?, ?, 'tool', 'submitting', ?, ?, ?, ?)").run(
      job.id, job.source === "nuworks" ? "nuworks" : "external", prep.letterId, json(prep.answers), json([shot]), now(),
    );
    const result = await adapter.submit(page);
    const after = await screenshot(page, job.id, "after-submit");
    const shots = json([shot, after]);
    if (result.status === "submitted") {
      db.prepare("UPDATE applications SET result = 'submitted', submitted_at = ?, screenshots = ? WHERE job_id = ?").run(now(), shots, job.id);
      transition(db, job.id, "submitted", result.confirmation.slice(0, 200), opts.runId);
      if (supervised) {
        setKv(db, `ats.${adapter.kind}.cleanSubmits`, cleanSubmits(db, adapter.kind) + 1);
        setKv(db, "external.liveUnlocked", true); // the dashboard's Live button works after one watched submit
      }
      return { jobId: job.id, result: "submitted", detail: result.confirmation.slice(0, 120) };
    }
    if (result.status === "unknown") {
      db.prepare("UPDATE applications SET result = 'submit_unknown', error = ?, screenshots = ? WHERE job_id = ?").run(result.detail, shots, job.id);
      transition(db, job.id, "submit_unknown", result.detail, opts.runId);
      setKv(db, `ats.${adapter.kind}.cleanSubmits`, 0); // back to supervised until it's reliable again
      return { jobId: job.id, result: "submit_unknown", detail: result.detail };
    }
    db.prepare("UPDATE applications SET result = 'needs_manual', error = ?, screenshots = ? WHERE job_id = ?").run(result.detail, shots, job.id);
    transition(db, job.id, "needs_manual", result.detail, opts.runId);
    return { jobId: job.id, result: "needs_manual", detail: result.detail };
  } catch (err) {
    if (err instanceof BrainUnavailableError) throw err;
    const shot = await screenshot(page, job.id, "error").catch(() => null);
    return manual(`${(err as Error).message.split("\n")[0]}${shot ? ` (${path.basename(shot)})` : ""}`);
  } finally {
    await context.close();
  }
}

interface Prepared {
  plan: FillPlan;
  blockers: string[];
  letterId: number | null;
  answers: { question: string; writingId?: number; value?: string }[];
}

// Standard fields from your profile; the rest from your answer bank, then the AI
// (humanized), and anything still uncertain stops the application.
async function buildPlan(db: Db, brain: Brain, me: Me, priv: PrivateInfo, s: Settings, job: JobRow, form: ApplyForm, runId: number): Promise<Prepared> {
  const letterField = form.fields.find((f) => f.role === "cover_letter");
  const wantLetter = letterField && (letterField.required || s.external.coverLetters === "whenAccepted");
  let letterId: number | null = null;
  let letterPdf: string | undefined;
  const blockers: string[] = [];

  if (wantLetter) {
    const existing = db.prepare("SELECT id, pdf_path, lint FROM writings WHERE job_id = ? AND kind = 'cover_letter' AND is_current = 1").get(job.id) as { id: number; pdf_path: string | null; lint: string } | undefined;
    if (existing?.pdf_path) {
      letterId = existing.id;
      letterPdf = existing.pdf_path;
    } else {
      const w = await writeCoverLetter({ brain, me, posting: toPrompt(job), db, runId });
      if (!w.lint.ok && letterField.required) blockers.push(`cover letter needs your review (${w.lint.problems.join("; ")})`);
      if (w.lint.ok || letterField.required) {
        letterPdf = path.join(LETTERS_DIR, `${job.id.replace(/[^a-z0-9]+/gi, "_")}-${w.id}.pdf`);
        const date = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: s.timezone });
        await renderPdf(letterHtml({ profile: me.profile, employer: job.employer, title: job.title, body: w.body, date }), letterPdf);
        db.prepare("UPDATE writings SET pdf_path = ? WHERE id = ?").run(letterPdf, w.id);
        letterId = w.id;
      }
    }
  }

  const { plan, unresolved } = standardFillPlan(form, me.profile, priv, { resume: me.files.resume!, coverLetter: letterPdf });
  const answers: Prepared["answers"] = [];
  const posting = toPrompt(job);

  for (const field of unresolved) {
    if (field.role === "cover_letter" || field.role === "resume") continue;
    const bank = answerFromBank(me.answers, field.label);
    if (bank) {
      const value = field.options?.length ? pickOption(field.options, bank.answer) : bank.answer;
      if (value) {
        plan[field.key] = field.type === "checkbox" && field.options?.length ? [value] : value;
        answers.push({ question: field.label, value });
        continue;
      }
    }
    if (field.type === "file") {
      if (field.required) blockers.push(`asks for a file: ${field.label}`);
      continue;
    }
    if (field.options?.length) {
      const { system, prompt } = choiceAnswerPrompt(me, posting, field.label, field.options);
      const { data } = await brain.structured({ purpose: `choice:${job.id}`, system, prompt, schema: ChoiceAnswer, tier: "score", runId });
      const choice = data.choice ? pickOption(field.options, data.choice) : null;
      if (choice && !data.needsHuman && data.confidence !== "low") {
        plan[field.key] = field.type === "checkbox" ? [choice] : choice;
        answers.push({ question: field.label, value: choice });
      } else if (field.required) blockers.push(`question needs you: "${field.label.slice(0, 80)}"${data.reason ? ` (${data.reason})` : ""}`);
      continue;
    }
    if (!field.required && !isWorthAnswering(field)) continue;
    const w = await writeAnswer({ brain, me, posting, question: field.label, maxChars: field.maxLength, db, runId });
    if (!w.needsHuman && w.lint.ok) {
      plan[field.key] = w.body;
      answers.push({ question: field.label, writingId: w.id ?? undefined });
    } else if (field.required) blockers.push(`question needs you: "${field.label.slice(0, 80)}" (${w.needsHuman ? "AI lacks the information" : w.lint.problems.join("; ")})`);
  }
  return { plan, blockers, letterId, answers };
}

// Answers can reveal follow-up questions ("If yes, explain"). Re-read the form
// once, plan the new fields the same way, and fill them; anything still missing
// that's required stops the application.
async function fillWithFollowUps(db: Db, brain: Brain, me: Me, priv: PrivateInfo, s: Settings, job: JobRow, adapter: DescribingAdapter, page: Page, form: ApplyForm, prep: Prepared, runId: number): Promise<{ filled: number; blockers: string[] }> {
  const known = (key: string) => form.fields.some((x) => x.key === key);
  const first = await adapter.fill(page, form, prep.plan);
  let filled = first.filled.length;
  const failed = first.failed.filter((f) => known(f.key) && form.fields.find((x) => x.key === f.key)?.required);
  let current = form;
  if (first.failed.some((f) => !known(f.key))) {
    current = await adapter.describe(page);
    const fresh = current.fields.filter((f) => !known(f.key));
    const more = await buildPlan(db, brain, me, priv, s, job, { ...current, fields: fresh }, runId);
    if (more.blockers.length) return { filled, blockers: more.blockers };
    prep.answers.push(...more.answers);
    const second = await adapter.fill(page, { ...current, fields: fresh }, more.plan);
    filled += second.filled.length;
    failed.push(...second.failed.filter((f) => current.fields.find((x) => x.key === f.key)?.required ?? true));
  }
  return { filled, blockers: failed.length ? [`couldn't fill: ${failed.map((f) => `${label(current, f.key)} (${f.reason})`).join(", ")}`] : [] };
}

// Optional free-text questions worth answering: the "why us / tell us" kind.
const isWorthAnswering = (f: FormField) => f.type === "textarea" && /(why|interest|tell us|describe|anything else|cover)/i.test(f.label);

const label = (form: ApplyForm, key: string) => form.fields.find((f) => f.key === key)?.label.slice(0, 60) ?? key;

async function screenshot(page: Page, jobId: string, tag: string): Promise<string> {
  const file = path.join(SCREENSHOTS_DIR, `${jobId.replace(/[^a-z0-9]+/gi, "_")}-${Date.now()}-${tag}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}
