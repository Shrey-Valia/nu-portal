import { type Db, json, now, tx } from "../db/db.js";
import { assertTransition, isJobState, type JobState } from "./states.js";

export type Level = "debug" | "info" | "warn" | "error";

export interface EventInput {
  runId?: number | null;
  jobId?: string | null;
  level?: Level;
  kind: string;
  message: string;
  data?: unknown;
}

export function logEvent(db: Db, e: EventInput): void {
  db.prepare("INSERT INTO events (ts, run_id, job_id, level, kind, message, data) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    now(),
    e.runId ?? null,
    e.jobId ?? null,
    e.level ?? "info",
    e.kind,
    e.message,
    json(e.data),
  );
  if (process.env.NUPORTAL_QUIET !== "1" && (e.level === "warn" || e.level === "error")) {
    console.error(`[${e.level}] ${e.kind}: ${e.message}`);
  }
}

export function jobStatus(db: Db, jobId: string): JobState {
  const row = db.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId) as { status: string } | undefined;
  if (!row) throw new Error(`Unknown job ${jobId}`);
  if (!isJobState(row.status)) throw new Error(`Job ${jobId} has unknown status ${row.status}`);
  return row.status;
}

// Moves a job to a new status atomically and records why.
export function transition(db: Db, jobId: string, to: JobState, reason?: string, runId?: number | null): void {
  tx(db, () => {
    const from = jobStatus(db, jobId);
    if (from === to) return;
    assertTransition(from, to);
    db.prepare("UPDATE jobs SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?").run(
      to,
      reason ?? null,
      now(),
      jobId,
    );
    logEvent(db, { runId, jobId, kind: "job.transition", message: `${from} -> ${to}${reason ? ` (${reason})` : ""}`, data: { from, to, reason } });
  });
}

export function startRun(db: Db, kind: string, opts: { mode?: string; via?: string; jobIds?: string[] } = {}): number {
  const result = db
    .prepare("INSERT INTO runs (kind, mode, requested_via, job_ids, pid, status, started_at) VALUES (?, ?, ?, ?, ?, 'running', ?)")
    .run(kind, opts.mode ?? null, opts.via ?? "cli", json(opts.jobIds), process.pid, now());
  return Number(result.lastInsertRowid);
}

export function finishRun(db: Db, runId: number, status: "ok" | "failed" | "halted", summary?: unknown): void {
  db.prepare("UPDATE runs SET status = ?, finished_at = ?, summary = ? WHERE id = ?").run(status, now(), json(summary), runId);
}

export function addBrainUsage(db: Db, runId: number | null | undefined, costUsd: number): void {
  if (!runId) return;
  db.prepare("UPDATE runs SET brain_calls = brain_calls + 1, brain_cost_usd = brain_cost_usd + ? WHERE id = ?").run(costUsd, runId);
}
