import { type Db, getKv, now, setKv, tx } from "../db/db.js";
import { logEvent, transition } from "./events.js";
import { HALTABLE, type JobState } from "./states.js";

// The offer-accepted kill switch. Northeastern lets you accept one co-op offer,
// and reneging can cost you co-op eligibility, so accepting stops everything.

export interface HaltInfo {
  employer: string;
  date: string;
  at: string;
}

export const CLEAR_PHRASE = "I accepted no offer";

export function haltInfo(db: Db): HaltInfo | null {
  return getKv<HaltInfo | null>(db, "halt", null);
}

export function setHalt(db: Db, employer: string, date: string): { halted: number } {
  return tx(db, () => {
    setKv(db, "halt", { employer, date, at: now() } satisfies HaltInfo);
    const marks = HALTABLE.map(() => "?").join(",");
    const ids = db.prepare(`SELECT id FROM jobs WHERE status IN (${marks})`).all(...HALTABLE) as { id: string }[];
    for (const { id } of ids) transition(db, id, "halted" as JobState, "offer accepted");
    logEvent(db, { level: "warn", kind: "halt.set", message: `Offer accepted at ${employer} (${date}). ${ids.length} pending jobs halted.` });
    return { halted: ids.length };
  });
}

export function clearHalt(db: Db, confirm: string): boolean {
  if (confirm !== CLEAR_PHRASE) return false;
  setKv(db, "halt", null);
  logEvent(db, { level: "warn", kind: "halt.cleared", message: "Kill switch cleared" });
  return true;
}

// Employers to tell you're no longer available (handbook: inform employers you interviewed with).
export function notifyList(db: Db): { employer: string; title: string; status: string }[] {
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
  return db
    .prepare(
      `SELECT j.employer, j.title, COALESCE(a.remote_status, a.result) AS status
       FROM applications a JOIN jobs j ON j.id = a.job_id
       WHERE a.result IN ('submitted', 'submit_unknown') AND (COALESCE(a.submitted_at, a.started_at) >= ? OR a.remote_status LIKE '%interview%' OR a.remote_status LIKE '%offer%')
       ORDER BY j.employer`,
    )
    .all(since) as { employer: string; title: string; status: string }[];
}
