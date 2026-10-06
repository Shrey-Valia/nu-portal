import { detectAts } from "../ats/detect.js";
import { SUPPORTED_ATS } from "../ats/types.js";
import { RELEVANCE_PROMPT_VERSION, RelevanceResults, relevancePrompt } from "../brain/prompts/relevance.js";
import type { Brain } from "../brain/types.js";
import type { Settings } from "../config/settings.js";
import { fingerprint } from "../core/dedupe.js";
import { logEvent, transition } from "../core/events.js";
import { shortHash } from "../core/util.js";
import { type Db, json, now } from "../db/db.js";
import { jobsInState, upsertJob } from "../jobs/store.js";
import type { Me } from "../me/load.js";
import { pullAndParse } from "../sources/index.js";

// Track B: job-list repos → jobs → filters (shared with Track A) → a cheap
// relevance pass → auto-approved, queued for you, or "apply manually".

export const externalJobId = (applyUrl: string) => `ext:${shortHash(applyUrl.toLowerCase())}`;

const OPEN = ["ready", "queued", "approved", "pending_score", "manual_todo", "discovered"];

export async function discoverExternal(db: Db, s: Settings, runId: number): Promise<{ listings: number; new: number; closed: number }> {
  let listings = 0;
  let fresh = 0;
  let closed = 0;
  for (const repoUrl of s.external.repos) {
    try {
      const { listings: all, repo, sha } = await pullAndParse(repoUrl);
      for (const l of all) {
        if (!l.active) {
          // Closed rows in README tables have no link, so match those by fingerprint.
          const rows = (
            l.applyUrl
              ? db.prepare("SELECT id, status FROM jobs WHERE id = ?").all(externalJobId(l.applyUrl))
              : db.prepare("SELECT id, status FROM jobs WHERE source = ? AND fingerprint = ?").all(`repo:${repo}`, fingerprint(l.company, l.title, l.locations[0] ?? null))
          ) as { id: string; status: string }[];
          for (const row of rows) {
            if (!OPEN.includes(row.status)) continue;
            transition(db, row.id, "expired", "closed in the job list", runId);
            closed++;
          }
          continue;
        }
        if (!l.applyUrl) continue;
        const id = externalJobId(l.applyUrl);
        listings++;
        const r = upsertJob(
          db,
          {
            id, source: `repo:${repo}`, sourceJobId: l.sourceId, title: l.title, employer: l.company, location: l.locations.join("; ") || null,
            term: l.terms.join(", ") || null, postedAt: l.postedAt, applyMethod: "external", applyUrl: l.applyUrl, ats: detectAts(l.applyUrl),
            coverLetter: "unknown", qualifications: { sponsorship: l.sponsorship }, raw: l,
          },
          runId,
        );
        if (r.isNew) fresh++;
      }
      logEvent(db, { runId, kind: "external.discover", message: `${repo}@${sha.slice(0, 7)}: ${all.length} listings, ${fresh} new` });
    } catch (err) {
      logEvent(db, { runId, level: "error", kind: "external.source_failed", message: `${repoUrl}: ${(err as Error).message}` });
    }
  }
  return { listings, new: fresh, closed };
}

export async function relevancePending(db: Db, brain: Brain, me: Me, s: Settings, runId: number, batchSize = 20) {
  const pending = jobsInState(db, "pending_score", "external");
  const counts = { approved: 0, queued: 0, manual: 0, below: 0 };
  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    const { system, prompt } = relevancePrompt(
      me,
      batch.map((j) => ({ id: j.id, company: j.employer, title: j.title, locations: j.location ? j.location.split("; ") : [], terms: j.term ? j.term.split(", ") : [], category: null })),
    );
    const { data, meta } = await brain.structured({ purpose: `relevance:${batch.length}`, system, prompt, schema: RelevanceResults, tier: "score", runId });
    const byId = new Map(data.results.map((r) => [r.id, r]));
    for (const job of batch) {
      const r = byId.get(job.id);
      if (!r) continue;
      db.prepare("INSERT INTO scores (job_id, scored_at, kind, score, why, model, prompt_version, profile_version) VALUES (?, ?, 'relevance', ?, ?, ?, ?, ?)").run(job.id, now(), r.relevance, r.reason, meta.model, RELEVANCE_PROMPT_VERSION, me.version);
      if (r.relevance < s.external.minRelevance) {
        transition(db, job.id, "below_bar", `relevance ${r.relevance}`, runId);
        counts.below++;
        continue;
      }
      const supported = job.ats !== null && (SUPPORTED_ATS as readonly string[]).includes(job.ats);
      const mode = supported ? s.external.adapters[job.ats as "greenhouse" | "lever" | "ashby"] : "off";
      if (mode === "auto") {
        transition(db, job.id, "approved", `auto: relevance ${r.relevance}`, runId);
        db.prepare("INSERT INTO decisions (job_id, decision, decided_by, reason_tags, note, score_at_decision, decided_at) VALUES (?, 'approve', 'auto', ?, ?, ?, ?)").run(job.id, json([]), "auto mode", r.relevance, now());
        counts.approved++;
      } else if (mode === "supervised") {
        transition(db, job.id, "queued", `relevance ${r.relevance}; ${job.ats} adapter supervised`, runId);
        counts.queued++;
      } else if (r.relevance >= 75) {
        transition(db, job.id, "manual_todo", supported ? `${job.ats} adapter is off` : `apply on ${job.ats ?? "employer site"} by hand`, runId);
        counts.manual++;
      } else {
        transition(db, job.id, "below_bar", `relevance ${r.relevance}; can't auto-apply on ${job.ats ?? "this site"}`, runId);
        counts.below++;
      }
    }
  }
  return counts;
}
