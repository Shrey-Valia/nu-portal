import { getBrain } from "../brain/index.js";
import { BrainUnavailableError } from "../brain/types.js";
import { loadSettings } from "../config/settings.js";
import { finishRun, logEvent, startRun } from "../core/events.js";
import { acquireLock } from "../core/lock.js";
import { localDay } from "../core/time.js";
import { backup, type Db, getKv, openDb } from "../db/db.js";
import { loadMe, type Me } from "../me/load.js";
import { notify } from "../notify/macos.js";
import type { NuworksAdapter } from "../nuworks/adapter.js";
import { AdapterNotReadyError } from "../nuworks/adapter.js";
import { openBrowser } from "../nuworks/browser.js";
import { FixtureAdapter } from "../nuworks/fixture-adapter.js";
import { LiveAdapter, NuworksSignedOutError } from "../nuworks/live-adapter.js";
import { checkSession } from "../nuworks/session.js";
import { writeDailyReport } from "../report/write.js";
import { applyExternal } from "./apply-external.js";
import { discoverExternal, relevancePending } from "./external.js";
import { discover, draftLetters, draftResumes, evaluate, expireStale, nuworksBudgetNow, scorePending, selectForQueue, syncApplications } from "./nuworks.js";

export interface DailyOptions {
  fixture?: string; // NUworks fixture JSON instead of the live site
  via?: "cli" | "schedule";
  nuworks?: boolean;
  external?: boolean;
  letters?: boolean;
  db?: Db;
  now?: Date; // tests pin the clock for pacing
}

export interface DailySummary {
  runId: number;
  nuworks: Record<string, unknown>;
  external: Record<string, unknown>;
  problems: string[];
  reportHtml: string | null;
}

// The morning run. Every step is safe to repeat; a failure in one track never
// stops the other or the report.
export async function runDaily(opts: DailyOptions = {}): Promise<DailySummary> {
  const release = acquireLock("daily", "a daily run that's already going");
  const db = opts.db ?? openDb();
  const s = loadSettings();
  const runId = startRun(db, "daily", { via: opts.via ?? "cli" });
  const summary: DailySummary = { runId, nuworks: {}, external: {}, problems: [], reportHtml: null };
  const problem = (msg: string, kind = "daily.problem") => {
    summary.problems.push(msg);
    logEvent(db, { runId, level: "warn", kind, message: msg });
  };
  let brainOk = true;
  const brain = getBrain();
  const ai = async <T>(label: string, fn: () => Promise<T>): Promise<T | null> => {
    if (!brainOk) return null;
    try {
      return await fn();
    } catch (err) {
      if (err instanceof BrainUnavailableError) {
        brainOk = false;
        problem(`Claude unavailable, AI steps paused until next run: ${err.message}`, "brain.unavailable");
        return null;
      }
      problem(`${label} failed: ${(err as Error).message}`);
      return null;
    }
  };

  try {
    let me: Me | null = null;
    try {
      me = loadMe();
    } catch (err) {
      problem(`Profile not ready: ${(err as Error).message}`);
    }
    const halt = getKv<{ employer: string } | null>(db, "halt", null);
    if (halt) problem(`Applying is halted (offer accepted at ${halt.employer}). Only syncing and reporting.`, "halt.active");

    // Track A: NUworks
    if (opts.nuworks !== false) {
      let adapter: NuworksAdapter | null = null;
      try {
        if (opts.fixture) adapter = new FixtureAdapter(opts.fixture);
        else {
          const handle = await openBrowser({ headless: true, readOnly: true, purpose: "the daily run" });
          const session = await checkSession(db, handle);
          if (session.status === "ok" || session.status === "sso_silent_ok") adapter = new LiveAdapter(handle, s);
          else {
            await handle.close();
            problem("NUworks needs you to sign in again: run npm run login", "session.needs_login");
          }
        }
        if (adapter) {
          const sync = await syncApplications(db, adapter, s, runId);
          summary.nuworks.capUsed = sync.count;
          if (!halt && me) {
            summary.nuworks.discover = await discover(db, adapter, runId, s.nuworks.maxDetailsPerRun);
            summary.nuworks.filters = evaluate(db, me, s, "nuworks", runId);
            summary.nuworks.scoring = await ai("Scoring", () => scorePending(db, brain, me!, s, runId));
            summary.nuworks.queue = selectForQueue(db, s, runId, opts.now);
            if (opts.letters !== false) summary.nuworks.letters = await ai("Cover letters", () => draftLetters(db, brain, me!, s, runId));
            if (opts.letters !== false && s.nuworks.tailorResume) summary.nuworks.resumes = await ai("Tailored resumes", () => draftResumes(db, brain, me!, runId));
          }
        }
      } catch (err) {
        if (err instanceof AdapterNotReadyError) problem(err.message, "nuworks.not_mapped");
        else if (err instanceof NuworksSignedOutError) problem(err.message, "session.needs_login");
        else problem(`NUworks step failed: ${(err as Error).message}`, "nuworks.failed");
      } finally {
        await adapter?.close();
      }
    }

    // Track B: job-list repos
    if (opts.external !== false && s.external.enabled && s.external.repos.length && me && !halt) {
      try {
        summary.external.discover = await discoverExternal(db, s, runId);
        summary.external.filters = evaluate(db, me, s, "external", runId);
        summary.external.routing = await ai("Relevance", () => relevancePending(db, brain, me!, s, runId));
        // Unattended submits only from the launchd schedule, and only for adapters that passed supervised runs.
        if (opts.via === "schedule" && process.env.NUPORTAL_LAUNCHD === "1") {
          summary.external.applied = await ai("External applying", () => applyExternal(db, brain, me!, s, { mode: "live", unattended: true, runId }));
        }
      } catch (err) {
        problem(`Job-list step failed: ${(err as Error).message}`, "external.failed");
      }
    }

    summary.nuworks.expired = expireStale(db, runId);
    const budget = nuworksBudgetNow(db, s, opts.now);
    summary.nuworks.budget = budget;

    const day = localDay(new Date(), s.timezone);
    try {
      const paths = await writeDailyReport(db, day, s);
      summary.reportHtml = paths.html;
    } catch (err) {
      problem(`Report failed: ${(err as Error).message}`, "report.failed");
    }

    const queued = Number((db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'").get() as { n: number }).n);
    const needsYou = Number((db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('needs_manual', 'manual_todo', 'submit_unknown')").get() as { n: number }).n);
    await notify(
      "NU Portal",
      `${queued} ready for review · ${needsYou} need you · cap ${budget.used}/${s.cycle.cap} · week ${s.nuworks.weeklyLimit - budget.weekRemaining}/${s.nuworks.weeklyLimit}`,
      summary.problems.length ? summary.problems[0] : `Open http://127.0.0.1:${s.server.port}`,
    );
    backup(db);
    finishRun(db, runId, halt ? "halted" : "ok", summary);
    return summary;
  } catch (err) {
    finishRun(db, runId, "failed", { error: (err as Error).message });
    throw err;
  } finally {
    release();
  }
}
