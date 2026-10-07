import { TMP } from "./helpers.js";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { SettingsSchema } from "../src/config/settings.js";
import { getKv, openDb, setKv } from "../src/db/db.js";
import { guiConfirm } from "../src/pipeline/confirm.js";
import { type RunningServer, startServer } from "../src/server/server.js";
import type { Spawner } from "../src/server/tasks.js";

const ME = process.env.NUPORTAL_ME_DIR!;
const SETTINGS_FILE = path.join(TMP, "settings.yaml");
const db = openDb(":memory:");
const spawned: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
let srv: RunningServer;

const fakeSpawner: Spawner = (args, logFile, env) => {
  spawned.push({ args, env });
  writeFileSync(logFile, `ran ${args.join(" ")}\n`);
  const child = Object.assign(new EventEmitter(), { pid: 1000 + spawned.length });
  setTimeout(() => child.emit("exit", 0), 10);
  return child as never;
};

before(async () => {
  mkdirSync(ME, { recursive: true });
  srv = await startServer({
    db,
    port: 0,
    settings: SettingsSchema.parse({ brain: { claudeBin: "claude-not-installed-xyz" }, external: { repos: ["https://github.com/acme/jobs"] } }),
    settingsFile: SETTINGS_FILE,
    spawner: fakeSpawner,
  });
});
after(() => srv.close());

const base = () => `http://127.0.0.1:${srv.port}`;
async function call(p: string, init: RequestInit & { json?: unknown } = {}) {
  const headers: Record<string, string> = { "X-NUPortal-Token": srv.token, ...(init.headers as Record<string, string>) };
  let body = init.body;
  if (init.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  const res = await fetch(base() + p, { method: init.method ?? (body ? "POST" : "GET"), headers, body });
  const text = await res.text();
  return { status: res.status, text, json: () => JSON.parse(text) };
}
const post = (p: string, json: unknown) => call(p, { method: "POST", json });

test("every app page renders without inline scripts", async () => {
  for (const p of ["/setup", "/profile", "/private", "/writing", "/settings", "/tasks", "/try", "/drafts"]) {
    const res = await call(p);
    assert.equal(res.status, 200, p);
    const inline = res.text.match(/<script(?![^>]*\bsrc=)[^>]*>|\son[a-z]+="/i);
    assert.equal(inline, null, `${p} has inline script: ${inline?.[0]}`);
  }
  assert.match((await call("/setup")).text, /Not installed/);
});

test("uploads: PDFs only, token required, saved into me/", async () => {
  const pdf = Buffer.from("%PDF-1.4\n%test\n");
  const up = (kind: string, data: Buffer, opts: { type?: string; token?: string; name?: string } = {}) =>
    fetch(`${base()}/api/upload/${kind}${opts.name ? `?name=${encodeURIComponent(opts.name)}` : ""}`, {
      method: "POST",
      headers: { "Content-Type": opts.type ?? "application/octet-stream", "X-NUPortal-Token": opts.token ?? srv.token },
      body: new Uint8Array(data),
    });
  assert.equal((await up("resume", pdf, { token: "wrong" })).status, 403);
  assert.equal((await up("resume", Buffer.from("not a pdf"))).status, 415);
  assert.equal((await up("resume", pdf, { type: "application/pdf" })).status, 415);
  assert.equal((await up("passport", pdf)).status, 404);
  assert.equal((await up("sample", Buffer.from("MZ"), { name: "virus.exe" })).status, 415);
  assert.equal((await up("resume", pdf)).status, 200);
  assert.ok(readFileSync(path.join(ME, "resume.pdf")).equals(pdf));
  assert.equal((await up("sample", Buffer.from("My essay"), { name: "../../essay.txt" })).status, 200);
  assert.ok(existsSync(path.join(ME, "samples", "essay.txt")), "path parts stripped from the name");
});

const FORM = {
  "identity.name": "Jane Husky",
  "identity.email": "husky.j@northeastern.edu",
  "education.majors": "Computer Science",
  "education.gradDate": "May 2028",
  "education.coopCycle": "Spring 2027",
  "education.coopNumber": "1",
  "workAuth.authorizedUS": "yes",
  "workAuth.needsSponsorship": "no",
  "workAuth.usCitizen": "",
  "targets.roles": "Software Engineer Co-op\nData Engineer Co-op",
  "targets.locations": "Boston, MA\nRemote",
  "targets.modalities": ["hybrid", "remote"],
};

test("LinkedIn is a link: validated, normalized, and held until the profile exists", async () => {
  assert.equal((await post("/api/linkedin", { url: "https://evil.example/in/jane" })).status, 400);
  assert.equal((await post("/api/linkedin", { url: "https://www.linkedin.com/company/acme" })).status, 400);
  assert.equal((await post("/api/linkedin", { url: "linkedin.com/in/jane-husky/" })).status, 200);
  assert.equal(readFileSync(path.join(ME, "linkedin.url"), "utf8").trim(), "https://www.linkedin.com/in/jane-husky");
  assert.match((await call("/setup")).text, /linkedin\.com\/in\/jane-husky/);
});

test("profile saves only when valid, and keeps the old version", async () => {
  const bad = await post("/api/profile", { form: { "identity.name": "Jane" } });
  assert.equal(bad.status, 400);
  assert.ok(bad.json().issues.includes("Email: please fill this in"), bad.text);
  assert.equal(existsSync(path.join(ME, "profile.yaml")), false);

  const good = await post("/api/profile", { form: FORM, advanced: "skills:\n  - id: python\n    name: Python\n    level: strong\nexperiences: []\nawards: []\nextras: []\n" });
  assert.equal(good.status, 200, good.text);
  const saved = readFileSync(path.join(ME, "profile.yaml"), "utf8");
  assert.match(saved, /Boston, MA/);
  assert.match(saved, /needsSponsorship: false/);
  assert.ok(!/usCitizen/.test(saved), "prefer-not-to-say leaves it out");
  assert.match(saved, /linkedin: https:\/\/www\.linkedin\.com\/in\/jane-husky/, "the link saved earlier is merged in");
  assert.equal(existsSync(path.join(ME, "linkedin.url")), false);
  assert.equal((await post("/api/linkedin", { url: "https://linkedin.com/in/jane-h" })).status, 200);
  assert.match(readFileSync(path.join(ME, "profile.yaml"), "utf8"), /in\/jane-h\n/);

  assert.equal((await post("/api/profile", { advanced: "secrets: true" })).status, 400);
  assert.equal((await post("/api/profile", { form: { ...FORM, "identity.preferredName": "J" } })).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM profile_versions WHERE file = 'profile.yaml'").get()!.n, 2); // link update + second save
});

test("private details validate and are saved owner-only", async () => {
  assert.equal((await post("/api/private", { dateOfBirth: "31/01/2005" })).status, 400);
  const res = await post("/api/private", { dateOfBirth: "2005-01-31", city: "Boston", gender: "Decline to self-identify", other: "Pronouns: they/them" });
  assert.equal(res.status, 200, res.text);
  const file = path.join(ME, "private.yaml");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.match(readFileSync(file, "utf8"), /Pronouns: they\/them/);
});

test("answer bank rejects duplicate ids", async () => {
  assert.equal((await post("/api/answers", { answers: [{ id: "a", match: "x", answer: "1" }, { id: "a", match: "y", answer: "2" }] })).status, 400);
  const ok = await post("/api/answers", { answers: [{ id: "Sponsorship", match: "sponsorship, visa", answer: "No" }] });
  assert.equal(ok.json().count, 1);
  assert.match(readFileSync(path.join(ME, "answers.yaml"), "utf8"), /id: sponsorship/);
});

test("settings validate and save to the settings file", async () => {
  assert.equal((await post("/api/settings", { "nuworks.weeklyLimit": -3 })).status, 400);
  const res = await post("/api/settings", { "nuworks.weeklyLimit": 15, "external.enabled": true, "external.repos": "https://github.com/acme/jobs/\nhttps://github.com/beta/list", "schedule.dailyTime": "07:45", "schedule.weekdaysOnly": true });
  assert.equal(res.status, 200, res.text);
  const saved = readFileSync(SETTINGS_FILE, "utf8");
  assert.match(saved, /weeklyLimit: 15/);
  assert.match(saved, /https:\/\/github.com\/acme\/jobs\n/);
  assert.match((await call("/settings")).text, /value="15"/);
});

test("tasks run only allowlisted commands with validated input", async () => {
  assert.equal((await post("/api/tasks", { kind: "rm -rf" })).status, 400);
  assert.equal((await post("/api/tasks", { kind: "apply-live" })).status, 400);
  assert.equal((await post("/api/tasks", { kind: "sources-pull", input: { repo: "https://github.com/evil/repo" } })).status, 400);
  assert.equal((await post("/api/tasks", { kind: "letter-sample", input: { employer: "Acme" } })).status, 400);
  const res = await post("/api/tasks", { kind: "daily" });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(spawned.at(-1)?.args, ["daily"]);
  assert.equal(spawned.at(-1)?.env.NUPORTAL_DASHBOARD_LIVE_TOKEN, undefined);
  const id = res.json().task.id;
  await new Promise((r) => setTimeout(r, 50));
  const t = await call(`/api/tasks/${id}`);
  assert.equal(t.json().status, "ok");
  assert.match(t.json().output, /ran daily/);
  const letter = await post("/api/tasks", { kind: "letter-sample", input: { employer: "Acme; rm -rf /", title: "SWE", posting: "Build things" } });
  assert.equal(letter.status, 200);
  assert.ok(spawned.at(-1)!.args.includes("Acme; rm -rf /"), "passed as one argv value, never through a shell");
});

test("live job-list runs need a click token and confirm each application in the app", async () => {
  const res = await post("/api/apply", { track: "external", mode: "live" });
  assert.equal(res.status, 200, res.text);
  const run = spawned.at(-1)!;
  assert.deepEqual(run.args.slice(0, 8), ["apply", "--track", "external", "--mode", "live", "--via", "dashboard", "--confirm"]);
  const issued = getKv<{ token: string } | null>(db, "dashboard.liveToken", null);
  assert.ok(issued && issued.token === run.env.NUPORTAL_DASHBOARD_LIVE_TOKEN);
  assert.equal((await post("/api/apply", { track: "nuworks", mode: "live" })).status, 409);

  setKv(db, "apply.pending", { id: "abc", summary: "Acme — SWE Co-op", screenshot: "/etc/passwd", at: "now" });
  const pending = (await call("/api/apply/pending")).json().pending;
  assert.equal(pending.id, "abc");
  assert.equal(pending.screenshot, null, "screenshots outside the screenshots folder are never linked");
  assert.equal((await post("/api/apply/confirm", { id: "nope", decision: "submit" })).status, 409);
  assert.equal((await post("/api/apply/confirm", { id: "abc", decision: "submit" })).status, 200);
  assert.deepEqual(getKv(db, "apply.answer", null), { id: "abc", decision: "submit" });
});

test("guiConfirm waits for the matching answer and cleans up", async () => {
  const local = openDb(":memory:");
  const waiting = guiConfirm(local, 5000)("summary", "/tmp/x.png");
  await new Promise((r) => setTimeout(r, 50));
  const p = getKv<{ id: string } | null>(local, "apply.pending", null)!;
  setKv(local, "apply.answer", { id: "other", decision: "submit" });
  await new Promise((r) => setTimeout(r, 900));
  setKv(local, "apply.answer", { id: p.id, decision: "skip" });
  assert.equal(await waiting, false);
  assert.equal(getKv(local, "apply.pending", "x"), null);
});

test("drafts: text drafts can be accepted; the profile draft goes through the editor", async () => {
  mkdirSync(path.join(ME, "drafts"), { recursive: true });
  writeFileSync(path.join(ME, "drafts", "stories.md"), "# Stories\n\n## [story:x] X\n- Result: shipped\n");
  writeFileSync(path.join(ME, "drafts", "profile.yaml"), "identity:\n  name: Draft Person\n");
  assert.match((await call("/drafts")).text, /Draft Person/);
  assert.equal((await post("/api/drafts/stories.md/accept", {})).status, 200);
  assert.match(readFileSync(path.join(ME, "stories.md"), "utf8"), /story:x/);
  assert.equal(existsSync(path.join(ME, "drafts", "stories.md")), false);
  assert.equal((await post("/api/drafts/profile.yaml/accept", {})).status, 400);
  assert.match((await call("/profile?from=draft")).text, /Draft Person/);
  assert.equal((await post("/api/drafts/..%2F..%2Fprofile.yaml/discard", {})).status, 404);
  assert.ok(existsSync(path.join(ME, "profile.yaml")), "nothing outside drafts was touched");
});

test("letter PDFs are served only from the letters folder", async () => {
  assert.equal((await call("/letters/..%2F..%2Fme%2Fprivate.yaml")).status, 404);
  assert.equal((await call("/letters/nope.pdf")).status, 404);
});
