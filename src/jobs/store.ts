import { fingerprint, normalizeName } from "../core/dedupe.js";
import { logEvent, transition } from "../core/events.js";
import type { FilterContext, JobFacts, Qualifications } from "../core/filters.js";
import type { JobState } from "../core/states.js";
import { sha256 } from "../core/util.js";
import { type Db, json, now, parseJson, tx } from "../db/db.js";

// Reading and writing the jobs table.

export interface JobInput {
  id: string; // "nuworks:<id>" or "ext:<hash>"
  source: string;
  sourceJobId?: string | null;
  title: string;
  employer: string;
  location?: string | null;
  modality?: string | null;
  term?: string | null;
  payText?: string | null;
  deadlineAt?: string | null;
  postedAt?: string | null;
  applyMethod?: "nuworks" | "external" | "unknown";
  applyUrl?: string | null;
  ats?: string | null;
  coverLetter?: "required" | "optional" | "not_accepted" | "unknown";
  requiredDocs?: string[];
  qualifications?: Qualifications;
  description?: string | null;
  raw?: unknown;
}

export interface JobRow {
  id: string;
  source: string;
  source_job_id: string | null;
  title: string;
  employer: string;
  location: string | null;
  modality: string | null;
  term: string | null;
  pay_text: string | null;
  deadline_at: string | null;
  posted_at: string | null;
  apply_method: string;
  apply_url: string | null;
  ats: string | null;
  cover_letter: string;
  required_docs: string | null;
  qualifications: string | null;
  description: string | null;
  content_hash: string | null;
  fingerprint: string;
  status: JobState;
  status_reason: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

// States where a content change means the earlier evaluation is stale.
const REEVALUATE: JobState[] = ["ready", "queued", "approved", "below_bar", "filtered_out"];

export function upsertJob(db: Db, j: JobInput, runId?: number | null): { isNew: boolean; changed: boolean } {
  const t = now();
  const hash = sha256([j.title, j.employer, j.location ?? "", j.description ?? "", j.deadlineAt ?? "", j.payText ?? ""].join("\u0000"));
  const fp = fingerprint(j.employer, j.title, j.location);
  return tx(db, () => {
    const existing = db.prepare("SELECT status, content_hash FROM jobs WHERE id = ?").get(j.id) as { status: JobState; content_hash: string } | undefined;
    if (!existing) {
      db.prepare(
        `INSERT INTO jobs (id, source, source_job_id, title, employer, location, modality, term, pay_text, deadline_at, posted_at,
          apply_method, apply_url, ats, cover_letter, required_docs, qualifications, description, raw, content_hash, fingerprint,
          status, first_seen_at, last_seen_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'discovered', ?, ?, ?)`,
      ).run(
        j.id, j.source, j.sourceJobId ?? null, j.title, j.employer, j.location ?? null, j.modality ?? null, j.term ?? null, j.payText ?? null,
        j.deadlineAt ?? null, j.postedAt ?? null, j.applyMethod ?? "unknown", j.applyUrl ?? null, j.ats ?? null, j.coverLetter ?? "unknown",
        json(j.requiredDocs ?? []), json(j.qualifications ?? {}), j.description ?? null, json(j.raw), hash, fp, t, t, t,
      );
      return { isNew: true, changed: false };
    }
    const changed = existing.content_hash !== hash;
    db.prepare(
      `UPDATE jobs SET title = ?, employer = ?, location = ?, modality = ?, term = ?, pay_text = ?, deadline_at = ?, posted_at = COALESCE(?, posted_at),
        apply_method = ?, apply_url = ?, ats = ?, cover_letter = ?, required_docs = ?, qualifications = ?, description = ?, raw = ?,
        content_hash = ?, fingerprint = ?, last_seen_at = ?, updated_at = ? WHERE id = ?`,
    ).run(
      j.title, j.employer, j.location ?? null, j.modality ?? null, j.term ?? null, j.payText ?? null, j.deadlineAt ?? null, j.postedAt ?? null,
      j.applyMethod ?? "unknown", j.applyUrl ?? null, j.ats ?? null, j.coverLetter ?? "unknown", json(j.requiredDocs ?? []), json(j.qualifications ?? {}),
      j.description ?? null, json(j.raw), hash, fp, t, t, j.id,
    );
    if (changed && REEVALUATE.includes(existing.status)) {
      const to: JobState = existing.status === "filtered_out" ? "discovered" : "pending_score";
      transition(db, j.id, to, "posting changed", runId);
      db.prepare("UPDATE writings SET is_current = 0 WHERE job_id = ?").run(j.id); // letters were written for the old text
      logEvent(db, { runId, jobId: j.id, kind: "job.changed", message: "Posting text changed; re-evaluating" });
    }
    return { isNew: false, changed };
  });
}

export function getJob(db: Db, id: string): JobRow | undefined {
  return db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
}

export function jobsInState(db: Db, state: JobState, source?: "nuworks" | "external"): JobRow[] {
  const where = source === "nuworks" ? "AND source = 'nuworks'" : source === "external" ? "AND source LIKE 'repo:%'" : "";
  return db.prepare(`SELECT * FROM jobs WHERE status = ? ${where} ORDER BY first_seen_at`).all(state) as unknown as JobRow[];
}

export function trackOf(row: Pick<JobRow, "source">): "nuworks" | "external" {
  return row.source === "nuworks" ? "nuworks" : "external";
}

export function factsOf(row: JobRow): JobFacts {
  return {
    track: trackOf(row),
    title: row.title,
    employer: row.employer,
    location: row.location,
    modality: row.modality,
    terms: row.term ? row.term.split(/\s*[,;]\s*/).filter(Boolean) : [],
    deadlineAt: row.deadline_at,
    postedAt: row.posted_at,
    payText: row.pay_text,
    description: row.description ?? "",
    qualifications: parseJson<Qualifications>(row.qualifications, {}),
    fingerprint: row.fingerprint,
  };
}

const COMMITTED: JobState[] = ["approved", "submitting", "submitted", "submit_unknown", "needs_manual", "applied_manual"];
const DECIDED: JobState[] = [...COMMITTED, "skipped"];

// Context for the filters: what you've already applied to or decided, per track.
export function filterContext(db: Db, track: "nuworks" | "external", base: Omit<FilterContext, "seenFingerprints" | "employerCounts">, excludeId?: string): FilterContext {
  const sourceWhere = track === "nuworks" ? "source = 'nuworks'" : "source LIKE 'repo:%'";
  const marks = DECIDED.map(() => "?").join(",");
  // Applied/decided anywhere counts as seen: no applying twice to the same role across tracks.
  const seen = db.prepare(`SELECT fingerprint FROM jobs WHERE status IN (${marks}) AND id != ?`).all(...DECIDED, excludeId ?? "") as { fingerprint: string }[];
  const committedMarks = COMMITTED.map(() => "?").join(",");
  const perEmployer = db
    .prepare(`SELECT employer, COUNT(*) AS n FROM jobs WHERE ${sourceWhere} AND status IN (${committedMarks}) AND id != ? GROUP BY employer`)
    .all(...COMMITTED, excludeId ?? "") as { employer: string; n: number }[];
  const employerCounts = new Map<string, number>();
  for (const r of perEmployer) {
    const k = normalizeName(r.employer);
    employerCounts.set(k, (employerCounts.get(k) ?? 0) + Number(r.n));
  }
  return { ...base, seenFingerprints: new Set(seen.map((s) => s.fingerprint)), employerCounts };
}

export function latestScore(db: Db, jobId: string, kind: "fit" | "relevance" = "fit"): { score: number; why: string } | null {
  return (db.prepare("SELECT score, why FROM scores WHERE job_id = ? AND kind = ? ORDER BY id DESC LIMIT 1").get(jobId, kind) as { score: number; why: string } | undefined) ?? null;
}
