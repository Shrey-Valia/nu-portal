import type { CalibrationExample } from "../brain/prompts/score.js";
import { normalizeTitle } from "../core/dedupe.js";
import { type Db, parseJson } from "../db/db.js";

interface DecisionRow {
  job_id: string;
  title: string;
  employer: string;
  decision: "approve" | "skip";
  reason_tags: string | null;
  note: string | null;
  score_at_decision: number | null;
}

// Your past approve/skip decisions, shown to the scorer so it learns what you
// actually say yes to: the most recent ones plus the most similar to this batch.
export function calibrationExamples(db: Db, batchTitles: string[], recent = 6, similar = 6): CalibrationExample[] {
  const rows = db
    .prepare(
      `SELECT d.job_id, j.title, j.employer, d.decision, d.reason_tags, d.note, d.score_at_decision
       FROM decisions d JOIN jobs j ON j.id = d.job_id
       WHERE d.decided_by = 'user' AND d.decision IN ('approve', 'skip')
       ORDER BY d.id DESC LIMIT 400`,
    )
    .all() as unknown as DecisionRow[];
  if (!rows.length) return [];
  const words = (s: string) => new Set(normalizeTitle(s).split(" ").filter((w) => w.length > 2));
  const batch = batchTitles.map(words);
  const overlap = (r: DecisionRow) => {
    const w = words(r.title);
    return Math.max(0, ...batch.map((b) => [...w].filter((x) => b.has(x)).length));
  };
  const picked = new Map<string, DecisionRow>();
  for (const r of rows.slice(0, recent)) picked.set(r.job_id, r);
  for (const r of [...rows].sort((a, b) => overlap(b) - overlap(a)).slice(0, similar * 2)) {
    if (picked.size >= recent + similar) break;
    if (overlap(r) > 0) picked.set(r.job_id, r);
  }
  return [...picked.values()].map((r) => ({
    title: r.title,
    employer: r.employer,
    score: r.score_at_decision,
    decision: r.decision,
    tags: parseJson<string[]>(r.reason_tags, []),
    note: r.note,
  }));
}

// Share of queued NUworks matches you approved recently; drives how many to queue.
export function approveRate(db: Db, fallback = 0.6): number {
  const r = db
    .prepare(
      `SELECT SUM(decision = 'approve') AS a, COUNT(*) AS n FROM (
         SELECT d.decision FROM decisions d JOIN jobs j ON j.id = d.job_id
         WHERE d.decided_by = 'user' AND j.source = 'nuworks' AND d.decision IN ('approve', 'skip')
         ORDER BY d.id DESC LIMIT 40)`,
    )
    .get() as { a: number | null; n: number };
  return r.n >= 8 ? Number(r.a) / r.n : fallback;
}
