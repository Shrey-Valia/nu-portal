import { randomBytes } from "node:crypto";
import { getKv, now, parseJson, setKv, tx } from "../db/db.js";
import { logEvent, transition } from "../core/events.js";
import { CLEAR_PHRASE, clearHalt, setHalt } from "../core/halt.js";
import { canTransition, isJobState, type JobState } from "../core/states.js";
import { readHalt } from "../report/build.js";
import { isDay } from "../core/time.js";
import { type ApplyMode, type ApplyTrack, type Ctx, HttpError, REASON_TAGS } from "./context.js";
import { handleSetupApi } from "./setup-api.js";
import { doneFollowUp } from "../pipeline/apply-nuworks.js";

type Body = Record<string, unknown>;
type Row = Record<string, unknown>;
export interface ApiResult {
  status: number;
  body: unknown;
}

const ok = (body: unknown): ApiResult => ({ status: 200, body });

function text(body: Body, key: string, max: number, required = true): string | null {
  const v = body[key];
  if (v === undefined || v === null || v === "") {
    if (required) throw new HttpError(400, `"${key}" is required`);
    return null;
  }
  if (typeof v !== "string") throw new HttpError(400, `"${key}" must be a string`);
  if (v.length > max) throw new HttpError(400, `"${key}" is too long (max ${max} characters)`);
  return v;
}

function jobRow(ctx: Ctx, id: string): { id: string; status: string; title: string } {
  const row = ctx.db.prepare("SELECT id, status, title FROM jobs WHERE id = ?").get(id) as Row | undefined;
  if (!row) throw new HttpError(404, "Unknown job");
  return { id: String(row.id), status: String(row.status), title: String(row.title) };
}

// transition() throws plain Errors; illegal moves are a conflict, not a crash.
function move(ctx: Ctx, jobId: string, to: JobState, reason: string): void {
  try {
    transition(ctx.db, jobId, to, reason);
  } catch (err) {
    if (err instanceof Error && /Illegal job transition/.test(err.message)) throw new HttpError(409, err.message);
    throw err;
  }
}

const TARGET = { approve: "approved", skip: "skipped", defer: "deferred" } as const;
// A deferred or skipped job is put back in the queue before the new decision applies.
const VIA_QUEUE: readonly string[] = ["deferred", "skipped"];

function decide(ctx: Ctx, jobId: string, body: Body): ApiResult {
  const decision = body.decision;
  if (decision !== "approve" && decision !== "skip" && decision !== "defer") {
    throw new HttpError(400, '"decision" must be approve, skip or defer');
  }
  const rawTags = body.reasonTags ?? [];
  if (!Array.isArray(rawTags) || rawTags.some((t) => !(REASON_TAGS as readonly unknown[]).includes(t))) {
    throw new HttpError(400, `"reasonTags" must be a list of: ${REASON_TAGS.join(", ")}`);
  }
  const tags = [...new Set(rawTags as string[])];
  const note = text(body, "note", 2000, false)?.trim() || null;

  const job = jobRow(ctx, jobId);
  if (decision === "approve" && readHalt(ctx.db)) throw new HttpError(409, "Halted after an accepted offer. Clear the halt before approving.");
  const from = job.status;
  const to = TARGET[decision];
  if (!isJobState(from)) throw new HttpError(409, `Job has unknown status ${from}`);
  if (from === to) throw new HttpError(409, `Job is already ${to}`);
  let steps: JobState[];
  if (canTransition(from, to)) steps = [to];
  else if (VIA_QUEUE.includes(from) && canTransition(from, "queued") && canTransition("queued", to)) steps = ["queued", to];
  else throw new HttpError(409, `Can't ${decision} a job that is ${from.replaceAll("_", " ")}`);

  const score = ctx.db
    .prepare("SELECT score FROM scores WHERE job_id = ? ORDER BY scored_at DESC, id DESC LIMIT 1")
    .get(jobId) as { score: number } | undefined;
  const reason = decision === "skip" ? `user skip${tags.length ? `: ${tags.join(", ")}` : ""}` : `user ${decision}`;
  const decisionId = tx(ctx.db, () => {
    for (const step of steps) move(ctx, jobId, step, step === to ? reason : "reopened for a new decision");
    const result = ctx.db
      .prepare(
        "INSERT INTO decisions (job_id, decision, decided_by, reason_tags, note, score_at_decision, decided_at) VALUES (?, ?, 'user', ?, ?, ?, ?)",
      )
      .run(jobId, decision, tags.length ? JSON.stringify(tags) : null, note, score?.score ?? null, now());
    return Number(result.lastInsertRowid);
  });
  return ok({ ok: true, jobId, status: to, decisionId });
}

function editLetter(ctx: Ctx, jobId: string, body: Body): ApiResult {
  const letter = text(body, "body", 20_000)!.replace(/\r\n?/g, "\n").trim();
  if (!letter) throw new HttpError(400, '"body" is empty');
  const job = jobRow(ctx, jobId);
  if (job.status === "submitting" || job.status === "submitted") {
    throw new HttpError(409, "This application is already being submitted or was submitted");
  }
  const saved = tx(ctx.db, () => {
    const prev = ctx.db
      .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM writings WHERE job_id = ? AND kind = 'cover_letter'")
      .get(jobId) as { v: number };
    const version = Number(prev.v) + 1;
    ctx.db.prepare("UPDATE writings SET is_current = 0 WHERE job_id = ? AND kind = 'cover_letter'").run(jobId);
    const r = ctx.db
      .prepare(
        "INSERT INTO writings (job_id, kind, version, source, draft, body, lint, is_current, created_at) VALUES (?, 'cover_letter', ?, 'edit', NULL, ?, NULL, 1, ?)",
      )
      .run(jobId, version, letter, now());
    logEvent(ctx.db, { jobId, kind: "writing.edit", message: `Cover letter v${version} edited in the dashboard` });
    return { id: Number(r.lastInsertRowid), version };
  });
  return ok({ ok: true, ...saved });
}

// You applied yourself (NUworks applying isn't automated yet): record it now
// instead of waiting for the next daily sync.
function markApplied(ctx: Ctx, jobId: string): ApiResult {
  const job = jobRow(ctx, jobId);
  if (!isJobState(job.status) || !canTransition(job.status, "applied_manual")) throw new HttpError(409, `Can't mark a job that is ${job.status.replaceAll("_", " ")} as applied`);
  const source = (ctx.db.prepare("SELECT source FROM jobs WHERE id = ?").get(jobId) as { source: string }).source;
  tx(ctx.db, () => {
    move(ctx, jobId, "applied_manual", "you marked it applied");
    ctx.db
      .prepare("INSERT OR IGNORE INTO applications (job_id, track, via, result, started_at, submitted_at) VALUES (?, ?, 'manual', 'submitted', ?, ?)")
      .run(jobId, source === "nuworks" ? "nuworks" : "external", now(), now());
  });
  return ok({ ok: true, jobId, status: "applied_manual" });
}

function haltNow(ctx: Ctx, body: Body): ApiResult {
  const employer = text(body, "employer", 200)!.trim();
  if (!employer) throw new HttpError(400, '"employer" is required');
  const date = body.date;
  if (!isDay(date)) throw new HttpError(400, '"date" must be YYYY-MM-DD');
  const { halted } = setHalt(ctx.db, employer, date);
  return ok({ ok: true, halted, halt: readHalt(ctx.db) });
}

function clearHaltNow(ctx: Ctx, body: Body): ApiResult {
  const wasHalted = Boolean(readHalt(ctx.db));
  if (typeof body.confirm !== "string" || !clearHalt(ctx.db, body.confirm)) throw new HttpError(400, `Type exactly: ${CLEAR_PHRASE}`);
  return ok({ ok: true, wasHalted });
}

function startApply(ctx: Ctx, body: Body): ApiResult {
  const track = body.track;
  const mode = body.mode;
  if (track !== "nuworks" && track !== "external") throw new HttpError(400, '"track" must be nuworks or external');
  if (mode !== "dry-run" && mode !== "rehearsal" && mode !== "live") throw new HttpError(400, '"mode" must be dry-run, rehearsal or live');
  if (readHalt(ctx.db)) throw new HttpError(409, "Halted after an accepted offer. Apply runs are off.");
  let liveToken: string | null = null;
  if (mode === "live") {
    // Job-list live runs ask you to confirm each supervised application in the app, so they
    // need no separate unlock. NUworks stays locked until its apply flow is built.
    // Both tracks confirm each supervised application in the app; no separate unlock.
    // One-time proof for the CLI that a person clicked Live in this dashboard.
    liveToken = randomBytes(32).toString("base64url");
    setKv(ctx.db, "dashboard.liveToken", { token: liveToken, track, at: now() });
  }
  const { pid, log } = ctx.spawnApply({ track: track as ApplyTrack, mode: mode as ApplyMode, liveToken });
  if (!pid) throw new HttpError(500, "Could not start the apply run");
  logEvent(ctx.db, { kind: "apply.requested", message: `${mode} ${track} apply started from the dashboard (pid ${pid})`, data: { track, mode, pid, log } });
  return ok({ ok: true, pid, log });
}

function latestRun(ctx: Ctx): ApiResult {
  const run = ctx.db.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT 1").get() as Row | undefined;
  if (!run) return ok({ run: null, events: [] });
  const events = (
    ctx.db
      .prepare("SELECT * FROM (SELECT id, ts, job_id, level, kind, message, data FROM events WHERE run_id = ? ORDER BY id DESC LIMIT 50) ORDER BY id")
      .all(run.id as number) as Row[]
  ).map((e) => ({ ...e, data: parseJson(e.data as string | null, null) }));
  return ok({
    run: { ...run, job_ids: parseJson(run.job_ids as string | null, null), summary: parseJson(run.summary as string | null, null) },
    events,
  });
}

function decideProposal(ctx: Ctx, idText: string, body: Body): ApiResult {
  const id = Number(idText);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(404, "Unknown proposal");
  const status = body.status;
  if (status !== "accepted" && status !== "rejected") throw new HttpError(400, '"status" must be accepted or rejected');
  const r = ctx.db.prepare("UPDATE proposals SET status = ?, decided_at = ? WHERE id = ?").run(status, now(), id);
  if (Number(r.changes) === 0) throw new HttpError(404, "Unknown proposal");
  logEvent(ctx.db, { kind: "proposal.decided", message: `Proposal ${id} ${status}`, data: { id, status } });
  return ok({ ok: true, id, status });
}

function param(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, "Bad URL");
  }
}

export function handleApi(ctx: Ctx, method: string, pathname: string, body: Body): ApiResult {
  const setup = handleSetupApi(ctx, method, pathname, body);
  if (setup) return setup;
  let m: RegExpMatchArray | null;
  if (method === "GET") {
    if (pathname === "/api/runs/latest") return latestRun(ctx);
    throw new HttpError(404, "Not found");
  }
  if (method !== "POST") throw new HttpError(405, "Method not allowed");
  if ((m = pathname.match(/^\/api\/jobs\/([^/]+)\/decision$/))) return decide(ctx, param(m[1]), body);
  if ((m = pathname.match(/^\/api\/jobs\/([^/]+)\/letter$/))) return editLetter(ctx, param(m[1]), body);
  if ((m = pathname.match(/^\/api\/jobs\/([^/]+)\/applied$/))) return markApplied(ctx, param(m[1]));
  if ((m = pathname.match(/^\/api\/followups\/([^/]+)\/done$/))) return ok({ ok: doneFollowUp(ctx.db, param(m[1])) });
  if (pathname === "/api/halt") return haltNow(ctx, body);
  if (pathname === "/api/halt/clear") return clearHaltNow(ctx, body);
  if (pathname === "/api/apply") return startApply(ctx, body);
  if ((m = pathname.match(/^\/api\/proposals\/([^/]+)$/))) return decideProposal(ctx, m[1], body);
  throw new HttpError(404, "Not found");
}
