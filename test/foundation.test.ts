import "./helpers.js";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { ROOT } from "../src/config/paths.js";
import { SettingsSchema } from "../src/config/settings.js";
import { canTransition, JOB_STATES } from "../src/core/states.js";
import { transition } from "../src/core/events.js";
import { acquireLock, LockBusyError } from "../src/core/lock.js";
import { getKv, now, openDb, setKv } from "../src/db/db.js";
import { extract } from "../src/brain/claude-cli.js";
import { AnswerBankSchema, PrivateSchema, ProfileSchema } from "../src/me/schema.js";
import { knownSourceIds, loadMe, parseStories, profileForBrain } from "../src/me/load.js";

test("settings defaults match the plan", () => {
  const s = SettingsSchema.parse({});
  assert.equal(s.cycle.cap, 100);
  assert.equal(s.nuworks.weeklyLimit, 20);
  assert.equal(s.nuworks.coverLetters, "required");
  assert.equal(s.external.enabled, false);
  assert.equal(s.external.adapters.greenhouse, "off");
});

test("example settings file parses", () => {
  const raw = parse(readFileSync(path.join(ROOT, "config", "settings.example.yaml"), "utf8"));
  assert.doesNotThrow(() => SettingsSchema.parse(raw));
});

test("every state has a transition table entry and terminal states are terminal", () => {
  for (const s of JOB_STATES) assert.equal(typeof canTransition(s, s), "boolean");
  assert.equal(canTransition("submitted", "approved"), false);
  assert.equal(canTransition("queued", "approved"), true);
  assert.equal(canTransition("discovered", "submitted"), false);
  assert.equal(canTransition("submitting", "submit_unknown"), true);
});

test("database migrates and transitions are logged", () => {
  const db = openDb(":memory:");
  const t = now();
  db.prepare(
    "INSERT INTO jobs (id, source, title, employer, fingerprint, first_seen_at, last_seen_at, updated_at) VALUES (?, 'nuworks', 'SWE Co-op', 'Acme', 'acme|swe co-op|boston', ?, ?, ?)",
  ).run("nuworks:1", t, t, t);
  transition(db, "nuworks:1", "pending_score", "passed filters");
  transition(db, "nuworks:1", "queued");
  assert.throws(() => transition(db, "nuworks:1", "submitted"), /Illegal job transition/);
  const events = db.prepare("SELECT kind FROM events WHERE job_id = 'nuworks:1'").all();
  assert.equal(events.length, 2);
  setKv(db, "halted", true);
  assert.equal(getKv(db, "halted", false), true);
});

test("locks are exclusive and released", () => {
  const release = acquireLock("test-lock");
  assert.throws(() => acquireLock("test-lock"), LockBusyError);
  release();
  const again = acquireLock("test-lock");
  again();
});

test("claude -p envelope parsing prefers structured_output", () => {
  assert.deepEqual(extract({ structured_output: { a: 1 }, result: "x" }), { a: 1 });
  assert.deepEqual(extract({ result: '```json\n{"a":2}\n```' }), { a: 2 });
  assert.equal(extract({ result: "not json" }), undefined);
});

test("me/ templates are valid and the AI view hides contact details", () => {
  const dir = process.env.NUPORTAL_ME_DIR!;
  mkdirSync(dir, { recursive: true });
  const t = (f: string) => path.join(ROOT, "templates", "me", f);
  copyFileSync(t("profile.example.yaml"), path.join(dir, "profile.yaml"));
  copyFileSync(t("stories.example.md"), path.join(dir, "stories.md"));
  copyFileSync(t("answers.example.yaml"), path.join(dir, "answers.yaml"));
  assert.doesNotThrow(() => PrivateSchema.parse(parse(readFileSync(t("private.example.yaml"), "utf8"))));
  assert.doesNotThrow(() => AnswerBankSchema.parse(parse(readFileSync(t("answers.example.yaml"), "utf8"))));

  const me = loadMe();
  assert.equal(me.stories[0].id, "tracker-launch");
  assert.ok(knownSourceIds(me).has("proj-tracker-1"));
  assert.ok(knownSourceIds(me).has("story:tracker-launch"));
  const view = profileForBrain(me);
  assert.ok(!view.includes("husky.j@northeastern.edu"));
  assert.ok(!view.includes("555 0100"));
});

test("duplicate profile ids are rejected", () => {
  const p = parse(readFileSync(path.join(ROOT, "templates", "me", "profile.example.yaml"), "utf8"));
  p.skills.push({ id: "python", name: "Python again", level: "working" });
  assert.equal(ProfileSchema.safeParse(p).success, false);
});

test("stories parser splits on headings", () => {
  const s = parseStories("intro\n## [story:a] First\nbody a\n## [story:b] Second\nbody b");
  assert.deepEqual(s.map((x) => [x.id, x.title, x.body]), [
    ["a", "First", "body a"],
    ["b", "Second", "body b"],
  ]);
});
