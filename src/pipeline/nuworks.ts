import path from "node:path";
import type { PostingForPrompt } from "../brain/prompts/context.js";
import { SCORE_PROMPT_VERSION, ScoreResults, scorePrompt } from "../brain/prompts/score.js";
import { type Brain, BrainUnavailableError } from "../brain/types.js";
import { LETTERS_DIR } from "../config/paths.js";
import { nuworksTerms, type Settings } from "../config/settings.js";
import { nuworksBudget } from "../core/budget.js";
import { logEvent, transition } from "../core/events.js";
import { canTransition } from "../core/states.js";
import { applyFilters } from "../core/filters.js";
import { looksLikeInjection, sanitizePosting } from "../core/sanitize.js";
import { localDay, startOfLocalDay, weekdaysLeftInWeek, weekStartDay } from "../core/time.js";
import { type Db, json, now, parseJson, tx } from "../db/db.js";
import { detectAts } from "../ats/detect.js";
import { SUPPORTED_ATS } from "../ats/types.js";
import { renderPdf } from "../letters/render-pdf.js";
import { letterHtml } from "../letters/template.js";
import type { Me } from "../me/load.js";
import type { NuworksAdapter } from "../nuworks/adapter.js";
import { nuworksJobUrl } from "../nuworks/live-adapter.js";
import { factsOf, filterContext, getJob, type JobRow, jobsInState, latestScore, upsertJob } from "../jobs/store.js";
import { writeCoverLetter } from "../writing/compose.js";
import { approveRate, calibrationExamples } from "./calibration.js";

// Track A steps. Each is safe to re-run: it only acts on jobs in the state it owns.

export function ensureCycle(db: Db, s: Settings): number {
  const row = db.prepare("SELECT id FROM cycles WHERE label = ?").get(s.cycle.label) as { id: number } | undefined;
  if (row) return row.id;
  db.prepare("UPDATE cycles SET active = 0").run();
  return Number(
    db.prepare("INSERT INTO cycles (label, cap, reserve, season_end, active, created_at) VALUES (?, ?, ?, ?, 1, ?)").run(s.cycle.label, s.cycle.cap, s.cycle.reserve, s.cycle.seasonEnd, now()).lastInsertRowid,
  );
}

export async function syncApplications(db: Db, adapter: NuworksAdapter, s: Settings, runId: number): Promise<{ count: number | null; offers: string[] }> {
  const snap = await adapter.applications();
  const cycleId = ensureCycle(db, s);
  const offers: string[] = [];
  tx(db, () => {
    db.prepare("INSERT INTO cap_snapshots (cycle_id, taken_at, nuworks_count, cap_shown, raw) VALUES (?, ?, ?, ?, ?)").run(cycleId, now(), snap.capCount ?? snap.rows.length, snap.capShown, json(snap.rows));
    for (const r of snap.rows) {
      const jobId = `nuworks:${r.jobId}`;
      // Applied by hand on NUworks (NUworks applying isn't automated yet): record it.
      const job = getJob(db, jobId);
      if (job && canTransition(job.status, "applied_manual")) {
        transition(db, jobId, "applied_manual", "found in your NUworks applications", runId);
        const at = r.appliedAt && !Number.isNaN(Date.parse(r.appliedAt)) ? new Date(r.appliedAt).toISOString() : now();
        db.prepare(
          "INSERT OR IGNORE INTO applications (job_id, track, cycle_id, via, result, started_at, submitted_at, remote_status) VALUES (?, 'nuworks', ?, 'manual', 'submitted', ?, ?, ?)",
        ).run(jobId, cycleId, at, at, r.status);
        logEvent(db, { runId, jobId, kind: "application.manual", message: `You applied to ${job.title} at ${job.employer}` });
      }
      const app = db.prepare("SELECT remote_status FROM applications WHERE job_id = ?").get(jobId) as { remote_status: string | null } | undefined;
      if (app && app.remote_status !== r.status) {
        db.prepare("UPDATE applications SET remote_status = ?, remote_status_at = ? WHERE job_id = ?").run(r.status, now(), jobId);
        logEvent(db, { runId, jobId, kind: "application.status", message: `${r.employer}: ${app.remote_status ?? "applied"} -> ${r.status}` });
      }
      if (/offer/i.test(r.status)) offers.push(`${r.employer} (${r.title})`);
    }
  });
  if (offers.length) logEvent(db, { runId, level: "warn", kind: "offer.detected", message: `Possible offer: ${offers.join(", ")}. If you accept one, use Offer accepted on the dashboard.` });
  return { count: snap.capCount ?? snap.rows.length, offers };
}

export async function discover(db: Db, adapter: NuworksAdapter, runId: number, maxDetails = Number.POSITIVE_INFINITY): Promise<{ seen: number; fetched: number; new: number; deferred: number }> {
  const summaries = await adapter.search();
  let fetched = 0;
  let fresh = 0;
  let deferred = 0;
  for (const sum of summaries) {
    const id = `nuworks:${sum.id}`;
    const known = getJob(db, id);
    // Listings give dates without times; compare by date so unchanged postings aren't re-fetched.
    const same = known && known.title === sum.title && (known.deadline_at ?? "").slice(0, 10) === (sum.deadlineAt ?? "").slice(0, 10);
    if (same) {
      db.prepare("UPDATE jobs SET last_seen_at = ? WHERE id = ?").run(now(), id);
      continue;
    }
    if (fetched >= maxDetails) {
      deferred++;
      continue; // the rest wait for the next run
    }
    const p = await adapter.detail(sum.id);
    fetched++;
    const ats = p.applyMethod === "external" && p.externalUrl ? detectAts(p.externalUrl) : null;
    const r = upsertJob(
      db,
      {
        id, source: "nuworks", sourceJobId: p.id, title: p.title, employer: p.employer, location: p.location, modality: p.modality, term: p.term,
        payText: p.payText, deadlineAt: p.deadlineAt, postedAt: p.postedAt, applyMethod: p.applyMethod,
        applyUrl: p.applyMethod === "external" ? p.externalUrl : nuworksJobUrl(p.id), ats,
        coverLetter: p.coverLetter, requiredDocs: p.requiredDocs, qualifications: p.qualifications, description: sanitizePosting(p.description), raw: p.raw,
      },
      runId,
    );
    if (r.isNew) fresh++;
  }
  logEvent(db, { runId, kind: "nuworks.discover", message: `${summaries.length} postings in search, ${fresh} new, ${fetched} details fetched${deferred ? `, ${deferred} more tomorrow` : ""}` });
  return { seen: summaries.length, fetched, new: fresh, deferred };
}

export function evaluate(db: Db, me: Me, s: Settings, track: "nuworks" | "external", runId: number): { passed: number; filtered: number } {
  let passed = 0;
  let filtered = 0;
  const base = {
    now: new Date(),
    wantedTerms: track === "nuworks" ? nuworksTerms(s) : s.external.terms,
    maxPerEmployer: track === "nuworks" ? s.nuworks.maxPerEmployer : s.external.maxPerCompany,
    postedWithinDays: track === "external" ? s.external.postedWithinDays : undefined,
  };
  for (const job of jobsInState(db, "discovered", track)) {
    const result = applyFilters(factsOf(job), me.profile, filterContext(db, track, base, job.id));
    if (result.pass) {
      transition(db, job.id, "pending_score", "passed filters", runId);
      passed++;
    } else {
      transition(db, job.id, "filtered_out", `${result.code}: ${result.reason}`, runId);
      filtered++;
    }
  }
  return { passed, filtered };
}

export function toPrompt(job: JobRow): PostingForPrompt {
  return { id: job.id, title: job.title, employer: job.employer, location: job.location, modality: job.modality, term: job.term, pay: job.pay_text, deadline: job.deadline_at, description: job.description ?? "" };
}

export async function scorePending(db: Db, brain: Brain, me: Me, s: Settings, runId: number, batchSize = 8): Promise<{ scored: number; ready: number; below: number; deferredForQuota: number }> {
  const today = startOfLocalDay(localDay(new Date(), s.timezone), s.timezone).toISOString();
  const usedToday = (db.prepare("SELECT COUNT(*) AS n FROM scores WHERE kind = 'fit' AND scored_at >= ?").get(today) as { n: number }).n;
  const pending = jobsInState(db, "pending_score", "nuworks");
  const allowance = Math.max(0, s.nuworks.maxScoresPerDay - Number(usedToday));
  const todo = pending.slice(0, allowance);
  let ready = 0;
  let below = 0;

  for (let i = 0; i < todo.length; i += batchSize) {
    const batch = todo.slice(i, i + batchSize);
    const { system, prompt } = scorePrompt(me, batch.map(toPrompt), calibrationExamples(db, batch.map((b) => b.title)));
    const { data, meta } = await brain.structured({ purpose: `score:${batch.length}`, system, prompt, schema: ScoreResults, tier: "score", runId });
    const byId = new Map(data.results.map((r) => [r.id, r]));
    for (const job of batch) {
      const r = byId.get(job.id);
      if (!r) {
        logEvent(db, { runId, jobId: job.id, level: "warn", kind: "score.missing", message: "Scorer skipped this posting; will retry next run" });
        continue;
      }
      const injected = r.suspectedInjection || looksLikeInjection(job.description ?? "");
      db.prepare(
        "INSERT INTO scores (job_id, scored_at, kind, score, why, matched, gaps, red_flags, suspected_injection, model, prompt_version, profile_version) VALUES (?, ?, 'fit', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(job.id, now(), injected ? 0 : r.score, r.why, json(r.matched), json(r.gaps), json(r.redFlags), injected ? 1 : 0, meta.model, SCORE_PROMPT_VERSION, me.version);
      if (injected) {
        transition(db, job.id, "filtered_out", "posting text tries to instruct the AI", runId);
        logEvent(db, { runId, jobId: job.id, level: "warn", kind: "score.injection", message: `${job.employer}: posting looked manipulated; filtered out` });
      } else if (r.score < s.nuworks.minScore) {
        transition(db, job.id, "below_bar", `score ${r.score}`, runId);
        below++;
      } else {
        transition(db, job.id, "ready", `score ${r.score}`, runId);
        ready++;
      }
    }
  }
  const deferredForQuota = pending.length - todo.length;
  if (deferredForQuota > 0) logEvent(db, { runId, kind: "score.quota", message: `${deferredForQuota} postings wait for tomorrow (daily scoring limit ${s.nuworks.maxScoresPerDay})` });
  return { scored: todo.length, ready, below, deferredForQuota };
}

export function nuworksBudgetNow(db: Db, s: Settings, at = new Date()) {
  const cycleId = ensureCycle(db, s);
  const snap = db.prepare("SELECT nuworks_count FROM cap_snapshots WHERE cycle_id = ? ORDER BY id DESC LIMIT 1").get(cycleId) as { nuworks_count: number | null } | undefined;
  const count = (sql: string, ...args: (string | number)[]) => Number((db.prepare(sql).get(...args) as { n: number }).n);
  const weekStart = startOfLocalDay(weekStartDay(at, s.timezone), s.timezone).toISOString();
  return nuworksBudget({
    cap: s.cycle.cap,
    reserve: s.cycle.reserve,
    usedNuworks: snap?.nuworks_count ?? null,
    usedLocal: count("SELECT COUNT(*) AS n FROM applications WHERE track = 'nuworks' AND result IN ('submitted', 'submit_unknown')"),
    weeklyLimit: s.nuworks.weeklyLimit,
    submittedThisWeek: count("SELECT COUNT(*) AS n FROM applications WHERE track = 'nuworks' AND result IN ('submitted', 'submit_unknown') AND COALESCE(submitted_at, started_at) >= ?", weekStart),
    approvedPending: count("SELECT COUNT(*) AS n FROM jobs WHERE source = 'nuworks' AND status IN ('approved', 'submitting')"),
    queuedPending: count("SELECT COUNT(*) AS n FROM jobs WHERE source = 'nuworks' AND status = 'queued'"),
    weekdaysLeft: weekdaysLeftInWeek(at, s.timezone),
    approveRate: approveRate(db),
    minDailyQueue: s.nuworks.minDailyQueue,
    maxDailyQueue: s.nuworks.maxDailyQueue,
  });
}

// Moves the best "ready" matches into your review queue, as many as pacing allows.
export function selectForQueue(db: Db, s: Settings, runId: number, at = new Date()): { queued: number; manual: number; target: number } {
  const budget = nuworksBudgetNow(db, s, at);
  const ready = jobsInState(db, "ready", "nuworks")
    .map((j) => ({ j, score: latestScore(db, j.id)?.score ?? 0 }))
    .sort((a, b) => b.score - a.score || (a.j.deadline_at ?? "9999").localeCompare(b.j.deadline_at ?? "9999"));
  let queued = 0;
  let manual = 0;
  for (const { j } of ready) {
    if (queued >= budget.dailyQueueTarget) break;
    const unsupportedExternal = j.apply_method === "external" && !(j.ats && (SUPPORTED_ATS as readonly string[]).includes(j.ats));
    if (unsupportedExternal) {
      transition(db, j.id, "manual_todo", `apply on employer site (${j.ats ?? "unknown system"})`, runId);
      manual++;
    } else {
      transition(db, j.id, "queued", undefined, runId);
      queued++;
    }
  }
  logEvent(db, { runId, kind: "nuworks.queue", message: `Queued ${queued} for review (target ${budget.dailyQueueTarget}; week ${budget.weekRemaining} left, cycle ${budget.cycleRemaining} left)` });
  return { queued, manual, target: budget.dailyQueueTarget };
}

// Cover letters for queued jobs that need one and don't have a current one.
export async function draftLetters(db: Db, brain: Brain, me: Me, s: Settings, runId: number, source: "nuworks" | "external" = "nuworks"): Promise<{ written: number; flagged: number }> {
  const policy = source === "nuworks" ? s.nuworks.coverLetters : s.external.coverLetters;
  const needs = (j: JobRow) => j.cover_letter === "required" || (policy === "whenAccepted" && (j.cover_letter === "optional" || j.cover_letter === "unknown"));
  const states = source === "nuworks" ? (["queued"] as const) : (["queued", "approved"] as const);
  const jobs = states.flatMap((st) => jobsInState(db, st, source)).filter(needs);
  let written = 0;
  let flagged = 0;
  for (const job of jobs) {
    const has = db.prepare("SELECT id FROM writings WHERE job_id = ? AND kind = 'cover_letter' AND is_current = 1").get(job.id);
    if (has) continue;
    try {
      const w = await writeCoverLetter({ brain, me, posting: toPrompt(job), db, runId });
      const pdf = path.join(LETTERS_DIR, `${job.id.replace(/[^a-z0-9]+/gi, "_")}-${w.id}.pdf`);
      const date = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: s.timezone });
      await renderPdf(letterHtml({ profile: me.profile, employer: job.employer, title: job.title, body: w.body, date }), pdf);
      db.prepare("UPDATE writings SET pdf_path = ? WHERE id = ?").run(pdf, w.id);
      written++;
      if (!w.lint.ok) {
        flagged++;
        logEvent(db, { runId, jobId: job.id, level: "warn", kind: "letter.flagged", message: `${job.employer}: letter needs a look (${w.lint.problems.join("; ")})` });
      }
    } catch (err) {
      if (err instanceof BrainUnavailableError) throw err;
      logEvent(db, { runId, jobId: job.id, level: "error", kind: "letter.failed", message: `${job.employer}: ${(err as Error).message}` });
    }
  }
  return { written, flagged };
}

// Deadlines passed, or sitting in the queue for a week.
export function expireStale(db: Db, runId: number, maxQueueDays = 7): number {
  const nowIso = now();
  const weekAgo = new Date(Date.now() - maxQueueDays * 86_400_000).toISOString();
  const rows = db
    .prepare(
      `SELECT id, status, deadline_at, updated_at FROM jobs
       WHERE status IN ('ready', 'queued', 'deferred', 'manual_todo', 'pending_score', 'approved')
       AND ((deadline_at IS NOT NULL AND deadline_at < ?) OR (status IN ('queued', 'deferred') AND updated_at < ?))`,
    )
    .all(nowIso, weekAgo) as { id: string; status: string; deadline_at: string | null; updated_at: string }[];
  for (const r of rows) transition(db, r.id, "expired", r.deadline_at && r.deadline_at < nowIso ? "deadline passed" : `in queue over ${maxQueueDays} days`, runId);
  return rows.length;
}

export function parseDocs(row: JobRow): string[] {
  return parseJson<string[]>(row.required_docs, []);
}
