import "./helpers.js";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { REPORTS_DIR } from "../src/config/paths.js";
import { SettingsSchema } from "../src/config/settings.js";
import { type Db, openDb, setKv } from "../src/db/db.js";
import { buildDailyReport } from "../src/report/build.js";
import { renderReportHtml } from "../src/report/render.js";
import { dayIn, dayRange, weekRange, weekStart } from "../src/core/time.js";
import { writeDailyReport } from "../src/report/write.js";
import { escapeHtml, html, raw, safeUrl } from "../src/server/html.js";

const settings = SettingsSchema.parse({});
const DAY = "2026-10-06"; // a Tuesday; ET is UTC-4 that day
const EVIL = "<script>alert(1)</script>";

function job(db: Db, id: string, fields: Record<string, unknown> = {}): void {
  const row = {
    id,
    source: id.startsWith("ext:") ? "repo:acme/jobs" : "nuworks",
    title: `Role ${id}`,
    employer: `Employer ${id}`,
    fingerprint: id,
    status: "discovered",
    first_seen_at: "2026-10-01T12:00:00.000Z",
    last_seen_at: "2026-10-01T12:00:00.000Z",
    updated_at: "2026-10-01T12:00:00.000Z",
    ...fields,
  };
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO jobs (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(
    ...(Object.values(row) as (string | number | null)[]),
  );
}

function insert(db: Db, table: string, row: Record<string, unknown>): number {
  const cols = Object.keys(row);
  const r = db
    .prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .run(...(Object.values(row) as (string | number | null)[]));
  return Number(r.lastInsertRowid);
}

function event(db: Db, ts: string, kind: string, fields: Record<string, unknown> = {}): void {
  insert(db, "events", { ts, level: "info", kind, message: kind, ...fields });
}

function seed(): { db: Db; letterId: number; answerId: number } {
  const db = openDb(":memory:");
  insert(db, "cycles", { id: 1, label: "Spring 2027", cap: 100, reserve: 10, active: 1, created_at: "2026-09-01T00:00:00.000Z" });
  insert(db, "cap_snapshots", { cycle_id: 1, taken_at: "2026-10-01T12:00:00.000Z", nuworks_count: 5 });
  insert(db, "cap_snapshots", { cycle_id: 1, taken_at: "2026-10-06T12:00:00.000Z", nuworks_count: 7 });
  insert(db, "cap_snapshots", { cycle_id: 1, taken_at: "2026-10-08T12:00:00.000Z", nuworks_count: 50 }); // after the report day

  // Applications
  job(db, "nuworks:1", { title: EVIL, employer: "Evil & Co", status: "submitted", location: "Boston, MA" });
  const letterId = insert(db, "writings", { job_id: "nuworks:1", kind: "cover_letter", version: 1, source: "draft", draft: "d", body: "b", created_at: "2026-10-06T13:00:00.000Z" });
  const answerId = insert(db, "writings", { job_id: "nuworks:1", kind: "answer", question: "Why?", version: 1, source: "draft", body: "Because", created_at: "2026-10-06T13:00:00.000Z" });
  insert(db, "scores", { job_id: "nuworks:1", scored_at: "2026-10-05T12:00:00.000Z", score: 50, why: "old score" });
  insert(db, "scores", { job_id: "nuworks:1", scored_at: "2026-10-06T12:00:00.000Z", score: 77, why: `Strong fit ${EVIL}` });
  insert(db, "applications", {
    job_id: "nuworks:1",
    track: "nuworks",
    cycle_id: 1,
    via: "tool",
    result: "submitted",
    letter_id: letterId,
    answers: JSON.stringify([{ question: "Why?", writingId: answerId }, { question: "GPA", value: "3.8" }]),
    screenshots: JSON.stringify(["/tmp/shots/nuworks-1/confirm.png"]),
    started_at: "2026-10-06T13:55:00.000Z",
    submitted_at: "2026-10-06T14:00:00.000Z",
  });
  job(db, "nuworks:2", { status: "submitted" });
  insert(db, "applications", {
    job_id: "nuworks:2", track: "nuworks", cycle_id: 1, via: "tool", result: "submitted",
    started_at: "2026-10-05T15:00:00.000Z", submitted_at: "2026-10-05T15:00:00.000Z",
    remote_status: "interview", remote_status_at: "2026-10-06T18:00:00.000Z",
  });
  // Sunday 11 PM ET: previous week, previous day.
  job(db, "nuworks:3", { status: "submitted" });
  insert(db, "applications", { job_id: "nuworks:3", track: "nuworks", via: "tool", result: "submitted", started_at: "2026-10-05T03:00:00.000Z", submitted_at: "2026-10-05T03:00:00.000Z" });
  job(db, "nuworks:4", { status: "applied_manual" });
  insert(db, "applications", { job_id: "nuworks:4", track: "nuworks", cycle_id: 1, via: "manual", result: "submitted", started_at: "2026-10-06T16:00:00.000Z" });
  job(db, "ext:1", { status: "submitted", ats: "greenhouse", apply_url: "https://boards.greenhouse.io/acme/jobs/1" });
  insert(db, "applications", { job_id: "ext:1", track: "external", via: "tool", result: "submitted", started_at: "2026-10-06T20:00:00.000Z", submitted_at: "2026-10-06T20:00:00.000Z" });
  job(db, "ext:2", { status: "failed", ats: "lever" });
  insert(db, "applications", { job_id: "ext:2", track: "external", via: "tool", result: "failed", started_at: "2026-10-06T20:30:00.000Z" });

  // Queue: deadline first (nulls last), then score.
  job(db, "nuworks:q1", { status: "queued", deadline_at: "2026-10-09T21:00:00.000Z", apply_url: "javascript:alert(1)" });
  job(db, "nuworks:q2", { status: "queued", deadline_at: "2026-10-08T21:00:00.000Z" });
  job(db, "nuworks:q3", { status: "queued" });
  job(db, "nuworks:q4", { status: "queued", deadline_at: "2026-10-08T21:00:00.000Z", pay_text: "$30/hr" });
  for (const [id, score] of [["nuworks:q1", 70], ["nuworks:q2", 65], ["nuworks:q3", 90], ["nuworks:q4", 85]] as const) {
    insert(db, "scores", { job_id: id, scored_at: "2026-10-06T10:00:00.000Z", score, why: `why ${id}`, gaps: JSON.stringify(["no Rust"]), red_flags: JSON.stringify([]) });
  }
  job(db, "nuworks:a1", { status: "approved", deadline_at: "2026-10-12T15:00:00.000Z" });
  job(db, "nuworks:a2", { status: "approved", deadline_at: "2026-10-20T15:00:00.000Z" });
  job(db, "nuworks:r1", { status: "ready" });

  // Needs you
  job(db, "ext:m1", { status: "needs_manual", status_reason: "Workday form", apply_url: "https://acme.wd5.myworkdayjobs.com/x" });
  job(db, "nuworks:m2", { status: "manual_todo" });
  job(db, "nuworks:u1", { status: "submit_unknown" });
  setKv(db, "session", { status: "needs_login", detail: "A sign-in page appeared. Run: npm run login", checkedAt: "2026-10-06T12:30:00.000Z" });
  event(db, "2026-10-06T19:00:00.000Z", "apply.captcha", { level: "warn", job_id: "ext:1", message: "Captcha on the Greenhouse form" });
  event(db, "2026-10-05T19:00:00.000Z", "apply.captcha", { level: "warn", message: "yesterday's captcha" });

  // Filtered today
  const tr = (ts: string, jobId: string, to: string, reason: string | null) =>
    event(db, ts, "job.transition", { job_id: jobId, data: JSON.stringify({ from: "x", to, reason }) });
  tr("2026-10-06T11:00:00.000Z", "f1", "filtered_out", "location");
  tr("2026-10-06T11:01:00.000Z", "f2", "filtered_out", "location");
  tr("2026-10-06T11:02:00.000Z", "f3", "below_bar", "score 40");
  tr("2026-10-06T11:03:00.000Z", "f4", "skipped", "user skip: pay");
  tr("2026-10-06T11:04:00.000Z", "f5", "queued", null);
  tr("2026-10-06T03:00:00.000Z", "f6", "filtered_out", "location"); // Oct 5 in ET

  // Brain usage and problems
  insert(db, "runs", { kind: "daily", status: "ok", started_at: "2026-10-06T12:00:00.000Z", brain_calls: 3, brain_cost_usd: 0.12 });
  insert(db, "runs", { kind: "daily", status: "ok", started_at: "2026-10-06T22:00:00.000Z", brain_calls: 2, brain_cost_usd: 0.05 });
  insert(db, "runs", { kind: "daily", status: "ok", started_at: "2026-10-05T12:00:00.000Z", brain_calls: 10, brain_cost_usd: 1 });
  event(db, "2026-10-06T15:00:00.000Z", "scrape.slow", { level: "warn", message: "Search page was slow" });
  event(db, "2026-10-06T15:30:00.000Z", "apply.failed", { level: "error", message: "Lever form changed" });
  event(db, "2026-10-06T15:45:00.000Z", "info.thing", { level: "info" });
  event(db, "2026-10-05T15:00:00.000Z", "old.warn", { level: "warn" });
  return { db, letterId, answerId };
}

test("time helpers handle ET days, DST and Monday weeks", () => {
  assert.deepEqual(dayRange("2026-10-06", "America/New_York"), { start: "2026-10-06T04:00:00.000Z", end: "2026-10-07T04:00:00.000Z" });
  // Nov 1 2026 is 25 hours long in New York (DST ends).
  assert.deepEqual(dayRange("2026-11-01", "America/New_York"), { start: "2026-11-01T04:00:00.000Z", end: "2026-11-02T05:00:00.000Z" });
  assert.equal(weekStart("2026-10-11"), "2026-10-05"); // Sunday belongs to the week that started Monday
  assert.equal(weekStart("2026-10-05"), "2026-10-05");
  assert.equal(weekRange("2026-10-06", "America/New_York").start, "2026-10-05T04:00:00.000Z");
  assert.equal(dayIn("America/New_York", "2026-10-07T03:59:00.000Z"), "2026-10-06");
});

test("html helper escapes interpolations, keeps raw and nested fragments, joins arrays", () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  const inner = html`<b>${EVIL}</b>`;
  assert.equal(html`<p>${inner}${raw("<i>ok</i>")}${["<", html`<br>`]}${null}${undefined}${false}${0}</p>`.value, "<p><b>&lt;script&gt;alert(1)&lt;/script&gt;</b><i>ok</i>&lt;<br>0</p>");
  assert.equal(safeUrl("javascript:alert(1)"), null);
  assert.equal(safeUrl("data:text/html,x"), null);
  assert.equal(safeUrl("https://example.com/a?b=1"), "https://example.com/a?b=1");
});

test("daily report numbers and sections", () => {
  const { db, letterId, answerId } = seed();
  const r = buildDailyReport(db, DAY, settings);
  const s = r.summary;

  assert.equal(r.range.start, "2026-10-06T04:00:00.000Z");
  assert.equal(s.capSnapshot?.count, 7, "latest snapshot taken by the end of the day");
  assert.equal(s.capFromApplications, 4);
  assert.equal(s.capUsed, 7);
  assert.equal(s.cap, 100);
  assert.equal(s.reserve, 10);
  assert.equal(s.weekStart, "2026-10-05");
  assert.equal(s.weekSubmitted, 3, "Mon + Tue + manual; the Sunday-night one is last week");
  assert.equal(s.weeklyLimit, 20);
  assert.deepEqual(s.appliedToday, { nuworks: 2, external: 1, total: 3 });
  assert.equal(s.queueSize, 4);
  assert.equal(s.session?.status, "needs_login");
  assert.equal(s.halt, null);

  const first = r.appliedToday.find((a) => a.jobId === "nuworks:1")!;
  assert.equal(first.score, 77);
  assert.match(first.why!, /^Strong fit/);
  assert.equal(first.letterId, letterId);
  assert.deepEqual(first.answerIds, [answerId]);
  assert.deepEqual(first.screenshots, ["/tmp/shots/nuworks-1/confirm.png"]);
  assert.equal(first.ats, "nuworks");
  assert.equal(r.appliedToday.find((a) => a.jobId === "ext:1")!.ats, "greenhouse");
  assert.equal(r.appliedToday.find((a) => a.jobId === "nuworks:4")!.via, "manual");
  assert.ok(!r.appliedToday.some((a) => a.jobId === "ext:2"), "failed applications are not 'applied'");

  assert.deepEqual(r.queue.map((q) => q.jobId), ["nuworks:q4", "nuworks:q2", "nuworks:q1", "nuworks:q3"]);
  assert.deepEqual(r.queue[0].gaps, ["no Rust"]);

  assert.deepEqual(r.needsYou.map((n) => n.kind), ["submit_unknown", "needs_manual", "manual_todo", "needs_login", "captcha"]);
  assert.equal(r.needsYou[1].message, "Workday form");
  assert.equal(s.needsYouCount, 5);

  assert.deepEqual(r.filteredCounts, [
    { status: "filtered_out", reason: "location", count: 2 },
    { status: "below_bar", reason: "score 40", count: 1 },
    { status: "skipped", reason: "user skip: pay", count: 1 },
  ]);
  assert.deepEqual(r.statusChanges.map((c) => [c.jobId, c.remoteStatus]), [["nuworks:2", "interview"]]);
  assert.deepEqual(r.deadlines.map((d) => [d.jobId, d.daysLeft]), [["nuworks:q2", 2], ["nuworks:q4", 2], ["nuworks:q1", 3], ["nuworks:a1", 6]]);
  assert.deepEqual(r.pacing, { weeklyLimit: 20, weekSubmitted: 3, weeklyRemaining: 17, cap: 100, used: 7, reserve: 10, cycleRemaining: 83, ready: 1 });
  assert.deepEqual(r.brain, { runs: 2, calls: 5, costUsd: 0.17 });
  assert.deepEqual(r.problems.map((p) => p.kind), ["scrape.slow", "apply.failed", "apply.captcha"]);
});

test("cap usage falls back to known applications when they exceed the snapshot", () => {
  const { db } = seed();
  db.exec("DELETE FROM cap_snapshots");
  const r = buildDailyReport(db, DAY, settings);
  assert.equal(r.summary.capSnapshot, null);
  assert.equal(r.summary.capUsed, 4);
  assert.equal(r.pacing.cycleRemaining, 86);
});

test("halt shows in the summary and the rendered report", () => {
  const { db } = seed();
  setKv(db, "halt", { employer: "Acme <b>", date: "2026-10-06", at: "2026-10-06T15:00:00.000Z" });
  const r = buildDailyReport(db, DAY, settings);
  assert.equal(r.summary.halt?.employer, "Acme <b>");
  const page = renderReportHtml(r);
  assert.match(page, /Halted\./);
  assert.ok(page.includes("Acme &lt;b&gt;"));
});

test("rendered report is self-contained and escapes posting text", () => {
  const { db } = seed();
  const page = renderReportHtml(buildDailyReport(db, DAY, settings));
  assert.ok(page.startsWith("<!doctype html>"));
  assert.ok(!page.includes(EVIL), "raw script tag must not appear");
  assert.ok(page.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(!/<script/i.test(page), "no scripts at all");
  assert.ok(!page.includes("javascript:"), "unsafe links are dropped");
  assert.ok(page.includes("Evil &amp; Co"));
  assert.match(page, /<style>[\s\S]*prefers-color-scheme:dark[\s\S]*<\/style>/);
  assert.ok(!/<link\b/i.test(page), "no external stylesheets");
  assert.match(page, /name="viewport"/);
  assert.equal((page.match(/<table>/g) ?? []).length, 3, "applied, queue, deadlines tables");
});

test("an empty database renders without errors", () => {
  const db = openDb(":memory:");
  const r = buildDailyReport(db, DAY, settings);
  assert.equal(r.summary.capUsed, 0);
  assert.equal(r.summary.cycle, null);
  assert.equal(r.summary.cap, 100);
  assert.match(renderReportHtml(r), /No applications went out today/);
  assert.throws(() => buildDailyReport(db, "2026-13-01", settings), /Invalid day/);
});

test("writeDailyReport writes json and html into REPORTS_DIR", () => {
  const { db } = seed();
  const out = writeDailyReport(db, DAY, settings);
  assert.equal(out.json, path.join(REPORTS_DIR, `${DAY}.json`));
  assert.equal(out.html, path.join(REPORTS_DIR, `${DAY}.html`));
  assert.ok(existsSync(out.html));
  const saved = JSON.parse(readFileSync(out.json, "utf8"));
  assert.equal(saved.day, DAY);
  assert.equal(saved.summary.appliedToday.total, 3);
  assert.throws(() => writeDailyReport(db, "../../etc", settings), /Invalid day/);
});
