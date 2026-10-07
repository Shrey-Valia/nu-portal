import type { Settings } from "../config/settings.js";
import { haltInfo } from "../core/halt.js";
import { type Db, getKv, now, parseJson } from "../db/db.js";
import { addDays, assertDay, dayIn, dayRange, daysBetween, localMidnight, weekRange, weekStart } from "../core/time.js";
import type {
  AppliedRow,
  DailyReport,
  DeadlineRow,
  FilteredCount,
  HaltInfo,
  NeedsYouItem,
  NeedsYouKind,
  ProblemEvent,
  QueueRow,
  SessionInfo,
  StatusChange,
  Track,
} from "./types.js";

type Row = Record<string, unknown>;

// Joins the newest scores row for each job.
export const LATEST_SCORE_JOIN =
  "LEFT JOIN scores s ON s.id = (SELECT id FROM scores WHERE job_id = j.id ORDER BY scored_at DESC, id DESC LIMIT 1)";

// An application counts as "applied" once it is confirmed submitted or you did it by hand.
const APPLIED = "(a.result = 'submitted' OR a.via = 'manual')";
const APPLIED_AT = "COALESCE(a.submitted_at, a.started_at)";

export function trackOf(source: string): Track {
  return source === "nuworks" ? "nuworks" : "external";
}

export function asStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => {
      if (typeof v === "string") return v;
      if (v && typeof v === "object" && "text" in v && typeof v.text === "string") return v.text;
      return v === null || v === undefined ? "" : JSON.stringify(v);
    })
    .filter((s) => s.length > 0);
}

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export function activeCycle(db: Db, settings: Settings): { id: number; label: string; cap: number; reserve: number } | null {
  const row = db
    .prepare("SELECT id, label, cap, reserve FROM cycles WHERE active = 1 ORDER BY (label = ?) DESC, id DESC LIMIT 1")
    .get(settings.cycle.label) as Row | undefined;
  return row ? { id: Number(row.id), label: String(row.label), cap: Number(row.cap), reserve: Number(row.reserve) } : null;
}

export function readSession(db: Db): SessionInfo | null {
  const s = getKv<SessionInfo | null>(db, "session", null);
  return s && typeof s.status === "string" ? s : null;
}

export function readHalt(db: Db): HaltInfo | null {
  const h = haltInfo(db);
  return h && typeof h === "object" && typeof h.employer === "string" ? h : null;
}

export function queueRows(db: Db): QueueRow[] {
  const rows = db
    .prepare(
      `SELECT j.*, s.score, s.why, s.gaps, s.red_flags, s.suspected_injection
       FROM jobs j ${LATEST_SCORE_JOIN}
       WHERE j.status = 'queued'
       ORDER BY j.deadline_at IS NULL, j.deadline_at, s.score DESC, j.first_seen_at`,
    )
    .all() as Row[];
  return rows.map((r) => ({
    jobId: String(r.id),
    title: String(r.title),
    employer: String(r.employer),
    location: str(r.location),
    modality: str(r.modality),
    term: str(r.term),
    payText: str(r.pay_text),
    deadlineAt: str(r.deadline_at),
    source: String(r.source),
    track: trackOf(String(r.source)),
    applyUrl: str(r.apply_url),
    score: num(r.score),
    why: str(r.why),
    gaps: asStrings(parseJson(str(r.gaps), [])),
    redFlags: asStrings(parseJson(str(r.red_flags), [])),
    suspectedInjection: Number(r.suspected_injection ?? 0) === 1,
    coverLetter: (["required", "optional", "not_accepted"].includes(String(r.cover_letter)) ? r.cover_letter : "unknown") as QueueRow["coverLetter"],
  }));
}

const NEEDS_YOU_DEFAULT: Record<string, string> = {
  submit_unknown: "Submit was clicked but not confirmed. Check the portal before anything else runs.",
  needs_manual: "The apply run stopped and left this for you.",
  manual_todo: "A match that has to be applied to by hand.",
};

export function needsYouItems(db: Db, range: { start: string; end: string }): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];
  const jobs = db
    .prepare(
      `SELECT j.id, j.title, j.employer, j.source, j.apply_url, j.status, j.status_reason, j.updated_at, a.error, a.track
       FROM jobs j LEFT JOIN applications a ON a.job_id = j.id
       WHERE j.status IN ('submit_unknown', 'needs_manual', 'manual_todo')
       ORDER BY CASE j.status WHEN 'submit_unknown' THEN 0 WHEN 'needs_manual' THEN 1 ELSE 2 END,
                j.deadline_at IS NULL, j.deadline_at, j.updated_at`,
    )
    .all() as Row[];
  for (const r of jobs) {
    const kind = String(r.status) as NeedsYouKind;
    items.push({
      kind,
      jobId: String(r.id),
      title: String(r.title),
      employer: String(r.employer),
      track: (str(r.track) as Track | null) ?? trackOf(String(r.source)),
      applyUrl: str(r.apply_url),
      message: str(r.status_reason) ?? str(r.error) ?? NEEDS_YOU_DEFAULT[kind] ?? kind,
      at: str(r.updated_at),
    });
  }
  const session = readSession(db);
  if (session?.status === "needs_login") {
    items.push({
      kind: "needs_login",
      jobId: null,
      title: null,
      employer: null,
      track: "nuworks",
      applyUrl: null,
      message: session.detail ?? "Your NUworks session expired. Run: npm run login",
      at: session.checkedAt ?? null,
    });
  }
  const captchas = db
    .prepare(
      `SELECT e.ts, e.job_id, e.message, j.title, j.employer, j.source, j.apply_url
       FROM events e LEFT JOIN jobs j ON j.id = e.job_id
       WHERE e.ts >= ? AND e.ts < ? AND e.kind LIKE '%captcha%'
       ORDER BY e.ts, e.id`,
    )
    .all(range.start, range.end) as Row[];
  for (const r of captchas) {
    items.push({
      kind: "captcha",
      jobId: str(r.job_id),
      title: str(r.title),
      employer: str(r.employer),
      track: r.source ? trackOf(String(r.source)) : null,
      applyUrl: str(r.apply_url),
      message: String(r.message),
      at: String(r.ts),
    });
  }
  return items;
}

export function buildDailyReport(db: Db, day: string, settings: Settings): DailyReport {
  assertDay(day);
  const tz = settings.timezone;
  const range = dayRange(day, tz);
  const week = weekRange(day, tz);
  const cycle = activeCycle(db, settings);
  const cap = cycle?.cap ?? settings.cycle.cap;
  const reserve = cycle?.reserve ?? settings.cycle.reserve;

  // Cap usage is "as of" the end of the report day so old reports stay stable.
  const snap = cycle
    ? (db
        .prepare(
          "SELECT nuworks_count, taken_at FROM cap_snapshots WHERE cycle_id = ? AND nuworks_count IS NOT NULL AND taken_at < ? ORDER BY taken_at DESC, id DESC LIMIT 1",
        )
        .get(cycle.id, range.end) as Row | undefined)
    : undefined;
  const capSnapshot = snap ? { count: Number(snap.nuworks_count), takenAt: String(snap.taken_at) } : null;
  // Applications without a cycle_id are assumed to belong to the active cycle.
  const capFromApplications = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM applications a
           WHERE a.track = 'nuworks' AND ${APPLIED} AND ${APPLIED_AT} < ?
             AND (? IS NULL OR a.cycle_id = ? OR a.cycle_id IS NULL)`,
        )
        .get(range.end, cycle?.id ?? null, cycle?.id ?? null) as Row
    ).n,
  );
  const capUsed = Math.max(capSnapshot?.count ?? 0, capFromApplications);

  const weekSubmitted = Number(
    (
      db
        .prepare(`SELECT COUNT(*) AS n FROM applications a WHERE a.track = 'nuworks' AND ${APPLIED} AND ${APPLIED_AT} >= ? AND ${APPLIED_AT} < ?`)
        .get(week.start, range.end) as Row
    ).n,
  );

  const appliedRows = db
    .prepare(
      `SELECT a.*, j.employer, j.title, j.location, j.ats, j.apply_url, s.score, s.why
       FROM applications a JOIN jobs j ON j.id = a.job_id ${LATEST_SCORE_JOIN}
       WHERE ${APPLIED} AND ${APPLIED_AT} >= ? AND ${APPLIED_AT} < ?
       ORDER BY ${APPLIED_AT}, a.id`,
    )
    .all(range.start, range.end) as Row[];
  const appliedToday: AppliedRow[] = appliedRows.map((r) => {
    const answers = parseJson<Array<{ writingId?: unknown }>>(str(r.answers), []);
    const track = String(r.track) as Track;
    return {
      applicationId: Number(r.id),
      jobId: String(r.job_id),
      company: String(r.employer),
      title: String(r.title),
      location: str(r.location),
      track,
      ats: str(r.ats) ?? (track === "nuworks" ? "nuworks" : null),
      via: String(r.via),
      result: String(r.result),
      score: num(r.score),
      why: str(r.why),
      letterId: num(r.letter_id),
      answerIds: (Array.isArray(answers) ? answers : [])
        .map((a) => (a && typeof a === "object" ? Number(a.writingId) : Number.NaN))
        .filter((n) => Number.isInteger(n)),
      applyUrl: str(r.apply_url),
      screenshots: asStrings(parseJson(str(r.screenshots), [])),
      submittedAt: str(r.submitted_at) ?? str(r.started_at),
    };
  });
  const perTrack = { nuworks: 0, external: 0, total: appliedToday.length };
  for (const a of appliedToday) perTrack[a.track]++;

  const queue = queueRows(db);
  const needsYou = needsYouItems(db, range);

  const filteredCounts = (
    db
      .prepare(
        `SELECT json_extract(data, '$.to') AS status, json_extract(data, '$.reason') AS reason, COUNT(DISTINCT COALESCE(job_id, id)) AS count
         FROM events
         WHERE kind = 'job.transition' AND ts >= ? AND ts < ? AND json_valid(data)
           AND json_extract(data, '$.to') IN ('filtered_out', 'below_bar', 'skipped')
         GROUP BY 1, 2
         ORDER BY count DESC, status, reason`,
      )
      .all(range.start, range.end) as Row[]
  ).map((r) => ({ status: String(r.status), reason: str(r.reason), count: Number(r.count) }) as FilteredCount);

  const statusChanges: StatusChange[] = (
    db
      .prepare(
        `SELECT a.id, a.job_id, a.track, a.remote_status, a.remote_status_at, j.employer, j.title
         FROM applications a JOIN jobs j ON j.id = a.job_id
         WHERE a.remote_status_at >= ? AND a.remote_status_at < ?
         ORDER BY a.remote_status_at, a.id`,
      )
      .all(range.start, range.end) as Row[]
  ).map((r) => ({
    applicationId: Number(r.id),
    jobId: String(r.job_id),
    company: String(r.employer),
    title: String(r.title),
    track: String(r.track) as Track,
    remoteStatus: str(r.remote_status),
    at: String(r.remote_status_at),
  }));

  const deadlineEnd = new Date(localMidnight(addDays(day, 7), tz)).toISOString();
  const deadlines: DeadlineRow[] = (
    db
      .prepare(
        `SELECT id, title, employer, status, source, deadline_at FROM jobs
         WHERE status IN ('queued', 'approved', 'manual_todo') AND deadline_at >= ? AND deadline_at < ?
         ORDER BY deadline_at, id`,
      )
      .all(range.start, deadlineEnd) as Row[]
  ).map((r) => ({
    jobId: String(r.id),
    title: String(r.title),
    employer: String(r.employer),
    status: String(r.status),
    track: trackOf(String(r.source)),
    deadlineAt: String(r.deadline_at),
    daysLeft: daysBetween(day, dayIn(tz, String(r.deadline_at))),
  }));

  const brainRow = db
    .prepare(
      "SELECT COUNT(*) AS runs, COALESCE(SUM(brain_calls), 0) AS calls, COALESCE(SUM(brain_cost_usd), 0) AS cost FROM runs WHERE started_at >= ? AND started_at < ?",
    )
    .get(range.start, range.end) as Row;

  const problems: ProblemEvent[] = (
    db
      .prepare(
        "SELECT id, ts, level, kind, message, job_id FROM events WHERE level IN ('warn', 'error') AND ts >= ? AND ts < ? ORDER BY ts, id LIMIT 500",
      )
      .all(range.start, range.end) as Row[]
  ).map((r) => ({
    id: Number(r.id),
    ts: String(r.ts),
    level: String(r.level) as "warn" | "error",
    kind: String(r.kind),
    message: String(r.message),
    jobId: str(r.job_id),
  }));

  const ready = Number((db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'ready'").get() as Row).n);
  const weeklyLimit = settings.nuworks.weeklyLimit;
  return {
    version: 1,
    day,
    timezone: tz,
    generatedAt: now(),
    range,
    week,
    summary: {
      cycle: cycle ? { id: cycle.id, label: cycle.label } : null,
      capUsed,
      capSnapshot,
      capFromApplications,
      cap,
      reserve,
      weekStart: weekStart(day),
      weekSubmitted,
      weeklyLimit,
      appliedToday: perTrack,
      queueSize: queue.length,
      needsYouCount: needsYou.length,
      session: readSession(db),
      halt: readHalt(db),
    },
    appliedToday,
    queue,
    needsYou,
    filteredCounts,
    statusChanges,
    deadlines,
    pacing: {
      weeklyLimit,
      weekSubmitted,
      weeklyRemaining: Math.max(0, weeklyLimit - weekSubmitted),
      cap,
      used: capUsed,
      reserve,
      cycleRemaining: Math.max(0, cap - capUsed - reserve),
      ready,
    },
    brain: { runs: Number(brainRow.runs), calls: Number(brainRow.calls), costUsd: Math.round(Number(brainRow.cost) * 10_000) / 10_000 },
    problems,
  };
}
