import "./helpers.js";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import { DATA_DIR, SCREENSHOTS_DIR } from "../src/config/paths.js";
import { SettingsSchema } from "../src/config/settings.js";
import { type Db, getKv, openDb, setKv } from "../src/db/db.js";
import { dayIn } from "../src/core/time.js";
import { writeDailyReport } from "../src/report/write.js";
import type { ApplyRequest } from "../src/server/context.js";
import { CSP, type RunningServer, startServer } from "../src/server/server.js";

const settings = SettingsSchema.parse({});
const EVIL = "<script>alert(1)</script>";
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a00000000049454e44ae426082", "hex");

let db: Db;
let srv: RunningServer;
const spawned: ApplyRequest[] = [];

function job(id: string, fields: Record<string, unknown> = {}): void {
  const t = "2026-10-01T12:00:00.000Z";
  const row = { id, source: "nuworks", title: `Role ${id}`, employer: `Employer ${id}`, fingerprint: id, status: "queued", first_seen_at: t, last_seen_at: t, updated_at: t, ...fields };
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO jobs (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...(Object.values(row) as (string | number | null)[]));
}

const status = (id: string) => (db.prepare("SELECT status FROM jobs WHERE id = ?").get(id) as { status: string }).status;

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: () => Record<string, unknown>;
}

function request(pathname: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: srv.port, path: pathname, method: opts.method ?? "GET", headers: { Host: `127.0.0.1:${srv.port}`, ...opts.headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) });
        });
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

function post(pathname: string, body: unknown, headers: Record<string, string> = {}): Promise<Res> {
  return request(pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-NUPortal-Token": srv.token, Origin: `http://127.0.0.1:${srv.port}`, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const decision = (id: string, body: unknown, headers?: Record<string, string>) => post(`/api/jobs/${encodeURIComponent(id)}/decision`, body, headers);

before(async () => {
  db = openDb(":memory:");
  job("nuworks:1", { title: EVIL, employer: "Evil & Co", description: `line one\nline two ${EVIL}`, apply_url: "javascript:alert(1)" });
  db.prepare("INSERT INTO scores (job_id, scored_at, score, why) VALUES ('nuworks:1', '2026-10-01T00:00:00.000Z', 40, 'old'), ('nuworks:1', '2026-10-02T00:00:00.000Z', 81, 'new')").run();
  job("nuworks:2");
  job("nuworks:3", { status: "deferred" });
  job("nuworks:4", { status: "submitted" });
  job("nuworks:5");
  job("nuworks:letter");
  db.prepare("INSERT INTO writings (job_id, kind, version, source, draft, body, created_at) VALUES ('nuworks:letter', 'cover_letter', 1, 'draft', 'raw draft', 'humanized', '2026-10-01T00:00:00.000Z')").run();
  srv = await startServer({
    db,
    port: 0,
    settings,
    spawnApply: (req) => {
      spawned.push(req);
      return { pid: 4242, log: null };
    },
  });
});

after(() => srv.close());

test("binds to 127.0.0.1 only", async () => {
  assert.match(srv.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  await assert.rejects(startServer({ db, port: 0, host: "0.0.0.0", settings }), /only binds to 127\.0\.0\.1/);
});

test("requests with a foreign Host header get 403", async () => {
  for (const host of ["evil.example", `evil.example:${srv.port}`, "127.0.0.1:1", `127.0.0.1.nip.io:${srv.port}`]) {
    const res = await request("/", { headers: { Host: host } });
    assert.equal(res.status, 403, host);
    assert.ok(!res.text.includes(srv.token), "token must not leak");
  }
  const api = await post("/api/halt", { employer: "x", date: "2026-10-06" }, { Host: "evil.example" });
  assert.equal(api.status, 403);
  assert.equal(getKv(db, "halt", null), null);
  assert.equal((await request("/", { headers: { Host: `localhost:${srv.port}` } })).status, 200);
});

test("pages carry strict security headers and no inline script or style", async () => {
  const res = await request("/");
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-security-policy"], CSP);
  assert.equal(
    CSP,
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.equal(res.headers["referrer-policy"], "no-referrer");
  assert.match(res.text, new RegExp(`<meta name="nuportal-token" content="${srv.token}">`));
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(res.text), "every script has a src");
  assert.ok(!/<style/i.test(res.text) && !/\sstyle=/i.test(res.text), "no inline styles");
  assert.ok(!/\son[a-z]+=/i.test(res.text), "no inline event handlers");
  assert.ok(!res.text.includes(EVIL));
  assert.ok(res.text.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(!res.text.includes("javascript:"));
  for (const p of ["/history", "/external", "/learning", "/offer"]) {
    const page = await request(p);
    assert.equal(page.status, 200, p);
    assert.equal(page.headers["content-security-policy"], CSP);
  }
  assert.equal((await request("/", { method: "PUT" })).status, 405);
  assert.equal((await request("/nope")).status, 404);
});

test("job page escapes the description and keeps line breaks", async () => {
  const res = await request(`/jobs/${encodeURIComponent("nuworks:1")}`);
  assert.equal(res.status, 200);
  assert.ok(!res.text.includes(EVIL));
  assert.ok(res.text.includes(`<div class="prewrap">line one\nline two &lt;script&gt;`));
  assert.ok(res.text.includes("Evil &amp; Co"));
  assert.equal((await request(`/jobs/${encodeURIComponent("nuworks:none")}`)).status, 404);
  assert.equal((await request("/jobs/%E0%A4%A")).status, 404);
});

test("API requires the token and a same-origin Origin", async () => {
  const noToken = await request(`/api/jobs/${encodeURIComponent("nuworks:2")}/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${srv.port}` },
    body: JSON.stringify({ decision: "approve" }),
  });
  assert.equal(noToken.status, 403);
  assert.equal((await decision("nuworks:2", { decision: "approve" }, { "X-NUPortal-Token": "wrong" })).status, 403);
  for (const origin of ["http://evil.example", `http://127.0.0.1:${srv.port + 1}`, "null", `https://127.0.0.1:${srv.port}`]) {
    assert.equal((await decision("nuworks:2", { decision: "approve" }, { Origin: origin })).status, 403, origin);
  }
  assert.equal(status("nuworks:2"), "queued");
  assert.equal((await request("/api/runs/latest")).status, 403, "GET API also needs the token");
});

test("API accepts only size-limited JSON objects", async () => {
  assert.equal((await decision("nuworks:2", "decision=approve", { "Content-Type": "application/x-www-form-urlencoded" })).status, 415);
  assert.equal((await decision("nuworks:2", "{not json")).status, 400);
  assert.equal((await decision("nuworks:2", "[1,2]")).status, 400);
  assert.equal((await decision("nuworks:2", { decision: "approve", note: "x".repeat(70_000) })).status, 413);
  assert.equal(status("nuworks:2"), "queued");
});

test("approve records a decision with the latest score", async () => {
  const res = await decision("nuworks:1", { decision: "approve" });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json().status, "approved");
  assert.equal(status("nuworks:1"), "approved");
  const d = db.prepare("SELECT * FROM decisions WHERE job_id = 'nuworks:1'").get() as Record<string, unknown>;
  assert.equal(d.decision, "approve");
  assert.equal(d.decided_by, "user");
  assert.equal(d.score_at_decision, 81);
});

test("skip stores reason tags; unknown tags are rejected", async () => {
  assert.equal((await decision("nuworks:2", { decision: "skip", reasonTags: ["made_up"] })).status, 400);
  const res = await decision("nuworks:2", { decision: "skip", reasonTags: ["pay", "location"], note: "too far" });
  assert.equal(res.status, 200);
  assert.equal(status("nuworks:2"), "skipped");
  const d = db.prepare("SELECT reason_tags, note FROM decisions WHERE job_id = 'nuworks:2'").get() as Record<string, string>;
  assert.deepEqual(JSON.parse(d.reason_tags), ["pay", "location"]);
  assert.equal(d.note, "too far");
  const reason = (db.prepare("SELECT status_reason FROM jobs WHERE id = 'nuworks:2'").get() as { status_reason: string }).status_reason;
  assert.equal(reason, "user skip: pay, location");
});

test("deferred jobs are requeued before a new decision", async () => {
  const res = await decision("nuworks:3", { decision: "approve" });
  assert.equal(res.status, 200, res.text);
  assert.equal(status("nuworks:3"), "approved");
  const moves = db.prepare("SELECT json_extract(data, '$.to') AS t FROM events WHERE job_id = 'nuworks:3' AND kind = 'job.transition' ORDER BY id").all() as { t: string }[];
  assert.deepEqual(moves.map((m) => m.t), ["queued", "approved"]);
});

test("illegal transitions return 409 and change nothing", async () => {
  assert.equal((await decision("nuworks:4", { decision: "approve" })).status, 409);
  assert.equal((await decision("nuworks:1", { decision: "approve" })).status, 409, "already approved");
  assert.equal((await decision("nuworks:1", { decision: "skip" })).status, 409, "approved -> skipped is not allowed");
  assert.equal(status("nuworks:4"), "submitted");
  assert.equal(status("nuworks:1"), "approved");
  assert.equal((await decision("nuworks:nope", { decision: "approve" })).status, 404);
  assert.equal((await decision("nuworks:5", { decision: "maybe" })).status, 400);
});

test("letter edits add a new current version", async () => {
  const res = await post(`/api/jobs/${encodeURIComponent("nuworks:letter")}/letter`, { body: "My edited letter\r\nSecond line" });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json().version, 2);
  const rows = db.prepare("SELECT version, source, draft, body, lint, is_current FROM writings WHERE job_id = 'nuworks:letter' ORDER BY version").all() as Record<string, unknown>[];
  assert.deepEqual(rows.map((r) => [r.version, r.is_current]), [[1, 0], [2, 1]]);
  assert.equal(rows[1].source, "edit");
  assert.equal(rows[1].draft, null);
  assert.equal(rows[1].lint, null);
  assert.equal(rows[1].body, "My edited letter\nSecond line");
  assert.equal((await post(`/api/jobs/${encodeURIComponent("nuworks:4")}/letter`, { body: "late" })).status, 409, "already submitted");
  assert.equal((await post(`/api/jobs/${encodeURIComponent("nuworks:letter")}/letter`, { body: "   " })).status, 400);
});

test("screenshots are served only from inside SCREENSHOTS_DIR", async () => {
  mkdirSync(path.join(SCREENSHOTS_DIR, "run 1"), { recursive: true });
  writeFileSync(path.join(SCREENSHOTS_DIR, "run 1", "confirm.png"), PNG);
  writeFileSync(path.join(DATA_DIR, "secret.png"), PNG);
  writeFileSync(path.join(SCREENSHOTS_DIR, "notes.txt"), "not an image");
  symlinkSync(path.join(DATA_DIR, "secret.png"), path.join(SCREENSHOTS_DIR, "link.png"));

  const ok = await request("/screenshots/run%201/confirm.png");
  assert.equal(ok.status, 200);
  assert.equal(ok.headers["content-type"], "image/png");
  for (const p of [
    "/screenshots/..%2Fsecret.png",
    "/screenshots/..%2F..%2F..%2F..%2Fetc%2Fpasswd",
    "/screenshots/%2Fetc%2Fpasswd",
    "/screenshots/../secret.png",
    "/screenshots/run%201%2F..%2F..%2Fsecret.png",
    "/screenshots/link.png",
    "/screenshots/notes.txt",
    "/screenshots/missing.png",
    "/screenshots/%00.png",
    "/screenshots/%E0%A4%A",
  ]) {
    const res = await request(p);
    assert.ok(res.status === 404 || res.status === 403, `${p} -> ${res.status}`);
    assert.notEqual(res.headers["content-type"], "image/png", p);
  }
});

test("static files come from a strict allowlist", async () => {
  const js = await request("/static/app.js");
  assert.equal(js.status, 200);
  assert.match(String(js.headers["content-type"]), /^text\/javascript/);
  assert.equal((await request("/static/style.css")).status, 200);
  for (const p of ["/static/server.ts", "/static/..%2Fserver.ts", "/static/../server.ts", "/static/constructor", "/static/"]) {
    assert.equal((await request(p)).status, 404, p);
  }
});

test("saved reports are served with a hash-only style policy", async () => {
  const day = dayIn(settings.timezone);
  writeDailyReport(db, day, settings);
  const res = await request(`/reports/${day}`);
  assert.equal(res.status, 200);
  const csp = String(res.headers["content-security-policy"]);
  assert.match(csp, /^default-src 'none'; style-src 'sha256-[A-Za-z0-9+/=]+'/);
  assert.ok(!csp.includes("unsafe-inline"));
  assert.ok(!res.text.includes(EVIL));
  for (const p of ["/reports/..%2F..%2Fnuportal", "/reports/2026-13-45", "/reports/1999-01-01"]) {
    assert.equal((await request(p)).status, 404, p);
  }
  const history = await request("/history");
  assert.ok(history.text.includes(`href="/reports/${day}"`));
});

test("proposals can be accepted or rejected", async () => {
  db.prepare("INSERT INTO proposals (id, created_at, kind, payload) VALUES (7, '2026-10-01T00:00:00.000Z', 'preference', '{\"avoid\":\"<b>x</b>\"}')").run();
  const page = await request("/learning");
  assert.ok(page.text.includes("&lt;b&gt;x&lt;/b&gt;"));
  assert.equal((await post("/api/proposals/7", { status: "maybe" })).status, 400);
  assert.equal((await post("/api/proposals/7", { status: "accepted" })).status, 200);
  const row = db.prepare("SELECT status, decided_at FROM proposals WHERE id = 7").get() as Record<string, unknown>;
  assert.equal(row.status, "accepted");
  assert.ok(row.decided_at);
  assert.equal((await post("/api/proposals/999", { status: "rejected" })).status, 404);
});

test("apply: live needs an unlock; dry runs spawn without a live token", async () => {
  assert.equal((await post("/api/apply", { track: "nuworks", mode: "live" })).status, 409);
  assert.equal(spawned.length, 0);
  assert.equal((await post("/api/apply", { track: "nuworks", mode: "yolo" })).status, 400);

  const dry = await post("/api/apply", { track: "external", mode: "dry-run" });
  assert.equal(dry.status, 200, dry.text);
  assert.equal(dry.json().pid, 4242);
  assert.deepEqual(spawned.at(-1), { track: "external", mode: "dry-run", liveToken: null });

  setKv(db, "nuworks.liveUnlocked", true);
  const live = await post("/api/apply", { track: "nuworks", mode: "live" });
  assert.equal(live.status, 200, live.text);
  const stored = getKv<{ token: string; track: string } | null>(db, "dashboard.liveToken", null);
  assert.equal(stored?.track, "nuworks");
  assert.ok(stored && stored.token.length >= 32);
  assert.equal(spawned.at(-1)?.liveToken, stored?.token);
});

test("latest run endpoint returns the run and its events", async () => {
  const runId = Number(db.prepare("INSERT INTO runs (kind, mode, status, started_at) VALUES ('apply-nuworks', 'dry-run', 'running', '2026-10-06T12:00:00.000Z')").run().lastInsertRowid);
  db.prepare("INSERT INTO events (ts, run_id, level, kind, message) VALUES ('2026-10-06T12:00:01.000Z', ?, 'info', 'apply.step', 'Opened form')").run(runId);
  const res = await request("/api/runs/latest", { headers: { "X-NUPortal-Token": srv.token } });
  assert.equal(res.status, 200);
  const body = res.json() as { run: { id: number }; events: { message: string }[] };
  assert.equal(body.run.id, runId);
  assert.deepEqual(body.events.map((e) => e.message), ["Opened form"]);
});

test("offer kill switch halts pending jobs and blocks approvals and applies", async () => {
  job("nuworks:h1");
  job("nuworks:h2", { status: "manual_todo" });
  job("nuworks:h3", { status: "deferred" });
  assert.equal((await post("/api/halt", { employer: "Acme", date: "June 1" })).status, 400);
  const res = await post("/api/halt", { employer: "Acme", date: "2026-10-06" });
  assert.equal(res.status, 200, res.text);
  for (const id of ["nuworks:h1", "nuworks:h2", "nuworks:h3", "nuworks:1", "nuworks:5"]) assert.equal(status(id), "halted", id);
  assert.equal(status("nuworks:4"), "submitted");
  assert.equal(getKv<{ employer: string } | null>(db, "halt", null)?.employer, "Acme");

  job("nuworks:late");
  assert.equal((await decision("nuworks:late", { decision: "approve" })).status, 409);
  assert.equal((await post("/api/apply", { track: "nuworks", mode: "dry-run" })).status, 409);
  const page = await request("/offer");
  assert.match(page.text, /Employers to notify/);
  assert.match(page.text, /co-op coordinator/);
  assert.match((await request("/")).text, /Halted\./);

  assert.equal((await post("/api/halt/clear", { confirm: "i accepted no offer" })).status, 400);
  assert.ok(getKv(db, "halt", null));
  assert.equal((await post("/api/halt/clear", { confirm: "I accepted no offer" })).status, 200);
  assert.equal(getKv(db, "halt", null), null);
});
