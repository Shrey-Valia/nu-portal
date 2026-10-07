import "./helpers.js";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import { createLeverAdapter } from "../src/ats/lever.js";
import { FakeBrain } from "../src/brain/fake.js";
import { ROOT } from "../src/config/paths.js";
import { SettingsSchema } from "../src/config/settings.js";
import { startRun } from "../src/core/events.js";
import { setHalt } from "../src/core/halt.js";
import { getKv, now, openDb, setKv } from "../src/db/db.js";
import { loadMe } from "../src/me/load.js";
import { applyExternal } from "../src/pipeline/apply-external.js";

const FIX = path.join(ROOT, "test", "fixtures", "synthetic", "ats");
const LEVER_ID = "5c3e8d2a-1f4b-4c6d-9e7f-0a1b2c3d4e5f";
const posts: string[] = [];
let server: Server;
let base = "";

before(async () => {
  server = createServer((req, res) => {
    const p = new URL(req.url ?? "/", "http://x").pathname;
    req.resume();
    req.on("end", () => {
      if (req.method === "POST") posts.push(p);
      const send = (status: number, file: string) => {
        res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
        res.end(readFileSync(path.join(FIX, file)));
      };
      if (p === `/lever/acme/${LEVER_ID}/apply` && req.method === "GET") return send(200, "lever.html");
      if (p === `/lever/acme/${LEVER_ID}/apply`) {
        res.writeHead(303, { location: `/lever/acme/${LEVER_ID}/thanks` });
        return res.end();
      }
      if (p === `/lever/acme/${LEVER_ID}/thanks`) return send(200, "lever-thanks.html");
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

  const dir = process.env.NUPORTAL_ME_DIR!;
  mkdirSync(dir, { recursive: true });
  for (const [src, dst] of [["profile.example.yaml", "profile.yaml"], ["stories.example.md", "stories.md"], ["answers.example.yaml", "answers.yaml"], ["voice.example.md", "voice.md"]]) {
    copyFileSync(path.join(ROOT, "templates", "me", src), path.join(dir, dst));
  }
  writeFileSync(path.join(dir, "resume.pdf"), "%PDF-1.4\n% test resume\n");
});

after(() => server.close());

const brain = new FakeBrain((req) => {
  if (req.purpose.startsWith("choice:")) return { choice: "Python", confidence: "high", needsHuman: false, reason: "listed skill" };
  if (req.purpose.startsWith("answer:")) return { answer: "I would build a robot that sorts recycling at home.", claims: [], confidence: "high", needsHuman: false, reason: "" };
  if (req.purpose.startsWith("humanize:")) return { text: "I'd build a robot that sorts recycling at home.", changes: [] };
  if (req.purpose.startsWith("resume:")) return { skillGroups: [{ label: "Languages", skills: ["Python", "TypeScript"] }], experiences: [], changes: ["Put Python first for this role"] };
  throw new Error(`unexpected brain call ${req.purpose}`);
});

const settings = (mode: "off" | "supervised" | "auto") =>
  SettingsSchema.parse({ external: { adapters: { lever: mode } }, pacing: { actionDelayMs: [0, 0], externalBetweenAppsMs: [0, 0] } });

function addJob(db: ReturnType<typeof openDb>, id: string) {
  const t = now();
  db.prepare(
    "INSERT INTO jobs (id, source, title, employer, apply_method, apply_url, ats, fingerprint, status, first_seen_at, last_seen_at, updated_at) VALUES (?, 'repo:test/list', 'Robotics Software Co-op', 'Acme Robotics', 'external', ?, 'lever', ?, 'approved', ?, ?, ?)",
  ).run(id, `${base}/lever/acme/${LEVER_ID}/apply`, `fp-${id}`, t, t, t);
}

const resolveAdapter = () => createLeverAdapter({ submitTimeoutMs: 10_000 });
const status = (db: ReturnType<typeof openDb>, id: string) => (db.prepare("SELECT status FROM jobs WHERE id = ?").get(id) as { status: string }).status;

test("dry run fills the form, sends nothing, and leaves the job approved", async () => {
  const db = openDb(":memory:");
  addJob(db, "ext:dry");
  const [o] = await applyExternal(db, brain, loadMe(), settings("off"), { resolveAdapter, runId: startRun(db, "test"), mode: "dry-run", unattended: false });
  assert.equal(o.result, "dry_run_ok", o.detail);
  assert.equal(status(db, "ext:dry"), "approved");
  assert.equal(posts.length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM applications").get()!.n, 0);
  assert.ok(brain.calls.some((c) => c.purpose.startsWith("humanize:")), "written answer went through the humanizer");
});

test("live: adapter off → needs you; supervised without a person → skipped", async () => {
  const db = openDb(":memory:");
  addJob(db, "ext:off");
  const [off] = await applyExternal(db, brain, loadMe(), settings("off"), { resolveAdapter, runId: startRun(db, "test"), mode: "live", unattended: true });
  assert.equal(off.result, "needs_manual");
  assert.equal(status(db, "ext:off"), "needs_manual");

  addJob(db, "ext:sup");
  const [sup] = await applyExternal(db, brain, loadMe(), settings("supervised"), { resolveAdapter, runId: startRun(db, "test"), mode: "live", unattended: true, jobIds: ["ext:sup"] });
  assert.equal(sup.result, "skipped");
  assert.equal(status(db, "ext:sup"), "approved");
  assert.equal(posts.length, 0);
});

test("supervised live submit after confirmation counts toward graduation", async () => {
  const db = openDb(":memory:");
  addJob(db, "ext:yes");
  let asked = "";
  const [o] = await applyExternal(db, brain, loadMe(), settings("supervised"), {
    resolveAdapter,
    runId: startRun(db, "test"),
    mode: "live",
    unattended: false,
    confirm: async (summary, shot) => {
      asked = summary;
      assert.ok(existsSync(shot));
      return true;
    },
  });
  assert.equal(o.result, "submitted", o.detail);
  assert.match(asked, /Acme Robotics/);
  assert.equal(status(db, "ext:yes"), "submitted");
  const app = db.prepare("SELECT result, track, via, screenshots FROM applications WHERE job_id = 'ext:yes'").get() as { result: string; track: string; via: string; screenshots: string };
  assert.deepEqual([app.result, app.track, app.via], ["submitted", "external", "tool"]);
  assert.equal(JSON.parse(app.screenshots).length, 2);
  assert.equal(getKv(db, "ats.lever.cleanSubmits", 0), 1);
  const resume = db.prepare("SELECT pdf_path FROM resumes WHERE job_id = 'ext:yes' AND is_current = 1").get() as { pdf_path: string };
  assert.ok(resume?.pdf_path && existsSync(resume.pdf_path), "a resume tailored to this job was made and uploaded");
  assert.equal(getKv(db, "external.liveUnlocked", false), true);
  assert.equal(posts.length, 1);
});

test("a graduated adapter in auto mode runs unattended; the kill switch stops everything", async () => {
  const db = openDb(":memory:");
  setKv(db, "ats.lever.cleanSubmits", 3);
  addJob(db, "ext:auto");
  const [o] = await applyExternal(db, brain, loadMe(), settings("auto"), { resolveAdapter, runId: startRun(db, "test"), mode: "live", unattended: true });
  assert.equal(o.result, "submitted", o.detail);

  addJob(db, "ext:halted");
  setHalt(db, "Acme Robotics", "2026-11-02");
  await assert.rejects(applyExternal(db, brain, loadMe(), settings("auto"), { resolveAdapter, runId: startRun(db, "test"), mode: "live", unattended: true }), /halted/);
  assert.equal(status(db, "ext:halted"), "halted");
});
