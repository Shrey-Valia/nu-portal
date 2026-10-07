import "./helpers.js";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { FakeBrain } from "../src/brain/fake.js";
import { setBrain } from "../src/brain/index.js";
import { ROOT } from "../src/config/paths.js";
import { setHalt } from "../src/core/halt.js";
import { openDb } from "../src/db/db.js";
import { runDaily } from "../src/pipeline/daily.js";

const dir = process.env.NUPORTAL_ME_DIR!;
mkdirSync(dir, { recursive: true });
for (const [src, dst] of [["profile.example.yaml", "profile.yaml"], ["stories.example.md", "stories.md"], ["answers.example.yaml", "answers.yaml"], ["voice.example.md", "voice.md"]]) {
  copyFileSync(path.join(ROOT, "templates", "me", src), path.join(dir, dst));
}

const FIXTURE = path.join(ROOT, "test", "fixtures", "synthetic", "nuworks", "postings.json");
const SCORES: Record<string, number> = { "nuworks:1001": 88, "nuworks:1002": 72, "nuworks:1005": 80 };
const LETTER = `Dear Hiring Team,\n\n${"I built a TypeScript tool that tracks co-op applications, which fits Lumen Health. ".repeat(13)}\n\nBest,\nJane`;

const brain = new FakeBrain((req) => {
  if (req.purpose.startsWith("score:")) {
    const ids = [...req.prompt.matchAll(/<posting id="([^"]+)"/g)].map((m) => m[1]);
    return { results: ids.map((id) => ({ id, score: SCORES[id] ?? 40, why: "fixture", matched: ["python"], gaps: [], redFlags: [], suspectedInjection: false })) };
  }
  if (req.purpose.startsWith("letter:")) return { body: LETTER, claims: [{ text: "tracker", sourceId: "proj-tracker-1" }] };
  if (req.purpose.startsWith("humanize:")) return { text: LETTER, changes: [] };
  if (req.purpose.startsWith("resume:")) return { skillGroups: [{ label: "Languages", skills: ["Python"] }], experiences: [], changes: ["Python first"] };
  throw new Error(`unexpected ${req.purpose}`);
});
setBrain(brain);

const status = (db: ReturnType<typeof openDb>, id: string) => (db.prepare("SELECT status, status_reason FROM jobs WHERE id = ?").get(id) as { status: string; status_reason: string }).status;

test("daily run: filters, scores, paces, queues, drafts letters, reports", async () => {
  const db = openDb(":memory:");
  const tuesday = new Date("2026-10-06T13:00:00Z");
  const s = await runDaily({ db, fixture: FIXTURE, external: false, now: tuesday });
  assert.deepEqual(s.problems, []);

  assert.equal(status(db, "nuworks:1001"), "queued");
  assert.equal(status(db, "nuworks:1002"), "queued");
  assert.equal(status(db, "nuworks:1003"), "filtered_out"); // mechanical engineering majors only
  assert.equal(status(db, "nuworks:1004"), "filtered_out"); // unpaid
  assert.equal(status(db, "nuworks:1005"), "manual_todo"); // Workday: apply by hand
  assert.equal(status(db, "nuworks:1006"), "filtered_out"); // Fall 2027 cycle

  const letter = db.prepare("SELECT body, pdf_path FROM writings WHERE job_id = 'nuworks:1001' AND is_current = 1").get() as { body: string; pdf_path: string };
  assert.ok(letter.body.includes("Lumen Health"));
  assert.ok(existsSync(letter.pdf_path), "letter PDF rendered");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM writings WHERE job_id = 'nuworks:1002'").get()!.n, 0); // optional letter: not written
  assert.equal(db.prepare("SELECT nuworks_count FROM cap_snapshots ORDER BY id DESC").get()!.nuworks_count, 3);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM resumes WHERE is_current = 1 AND pdf_path IS NOT NULL").get()!.n, 2, "a tailored resume for each queued job");
  assert.ok(s.reportHtml && existsSync(s.reportHtml));

  // Second run the same day changes nothing and never re-scores.
  const calls = brain.calls.length;
  await runDaily({ db, fixture: FIXTURE, external: false, now: tuesday });
  assert.equal(brain.calls.length, calls);
  assert.equal(status(db, "nuworks:1001"), "queued");
});

test("kill switch halts pending jobs and blocks new queueing", async () => {
  const db = openDb(":memory:");
  await runDaily({ db, fixture: FIXTURE, external: false, letters: false, now: new Date("2026-10-06T13:00:00Z") });
  const { halted } = setHalt(db, "Lumen Health", "2026-11-02");
  assert.ok(halted >= 2);
  assert.equal(status(db, "nuworks:1001"), "halted");
  const s = await runDaily({ db, fixture: FIXTURE, external: false, letters: false });
  assert.ok(s.problems.some((p) => p.includes("halted")));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'").get()!.n, 0);
});

test("jobs you apply to by hand on NUworks are recorded by the next sync", async () => {
  const { readFileSync: read, writeFileSync: write } = await import("node:fs");
  const { TMP } = await import("./helpers.js");
  const db = openDb(":memory:");
  const tuesday = new Date("2026-10-06T13:00:00Z");
  await runDaily({ db, fixture: FIXTURE, external: false, letters: false, now: tuesday });
  assert.equal(status(db, "nuworks:1001"), "queued");
  const data = JSON.parse(read(FIXTURE, "utf8"));
  data.applications = { rows: [{ jobId: "1001", title: "Backend Software Engineer Co-op", employer: "Lumen Health", appliedAt: "Oct 06, 2026, 2:19 PM", status: "submitted" }], capCount: 4, capShown: null };
  const withApp = path.join(TMP, "postings-applied.json");
  write(withApp, JSON.stringify(data));
  const s = await runDaily({ db, fixture: withApp, external: false, letters: false, now: tuesday });
  assert.equal(status(db, "nuworks:1001"), "applied_manual");
  const app = db.prepare("SELECT via, result, submitted_at FROM applications WHERE job_id = 'nuworks:1001'").get() as { via: string; result: string; submitted_at: string };
  assert.deepEqual([app.via, app.result], ["manual", "submitted"]);
  assert.match(app.submitted_at, /^2026-10-06T/);
  assert.equal((s.nuworks.budget as { weekRemaining: number }).weekRemaining, 19, "counts toward this week's 20");
});
