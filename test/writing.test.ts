import "./helpers.js";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { FakeBrain } from "../src/brain/fake.js";
import { cliSchema } from "../src/brain/claude-cli.js";
import { LetterDraft } from "../src/brain/prompts/letter.js";
import { ROOT } from "../src/config/paths.js";
import { now, openDb } from "../src/db/db.js";
import { checkClaims, lintWriting } from "../src/letters/lint.js";
import { letterHtml } from "../src/letters/template.js";
import { loadMe } from "../src/me/load.js";
import { answerFromBank, pickOption } from "../src/writing/answer-bank.js";
import { writeAnswer, writeCoverLetter } from "../src/writing/compose.js";

const dir = process.env.NUPORTAL_ME_DIR!;
mkdirSync(dir, { recursive: true });
for (const [src, dst] of [["profile.example.yaml", "profile.yaml"], ["stories.example.md", "stories.md"], ["answers.example.yaml", "answers.yaml"], ["voice.example.md", "voice.md"]]) {
  copyFileSync(path.join(ROOT, "templates", "me", src), path.join(dir, dst));
}
const me = loadMe();

const posting = { id: "nuworks:42", title: "Backend Co-op", employer: "Lumen Health", location: "Boston, MA", modality: "hybrid", term: "Spring 2027", pay: "$30/hr", deadline: null, description: "Python services for 400 clinics." };

const LETTER = `Dear Hiring Team,\n\n${"I built a TypeScript tool that tracks co-op applications at Lumen Health scale. ".repeat(14)}\n\nBest,\nJane`;

test("lint catches the things that must never be sent", () => {
  assert.ok(lintWriting(LETTER, { kind: "cover_letter", employer: "Lumen Health" }).ok);
  const bad = lintWriting("Dear [Company], as an AI I am **excited**. See https://x.y", { kind: "cover_letter", employer: "Lumen Health" });
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some((p) => p.includes("placeholder")));
  assert.ok(bad.problems.some((p) => p.includes("AI")));
  assert.ok(bad.problems.some((p) => p.includes("markdown")));
  assert.ok(bad.problems.some((p) => p.includes("link")));
  assert.ok(bad.problems.some((p) => p.includes("never mentions")));
  const invented = lintWriting("I cut latency by 73% at Lumen Health.", { kind: "answer", sources: ["I cut latency at Lumen Health."] });
  assert.ok(invented.problems.some((p) => p.includes("73%")));
  assert.deepEqual(checkClaims([{ text: "x", sourceId: "proj-tracker-1" }, { text: "y", sourceId: "made-up" }], new Set(["proj-tracker-1"])).length, 1);
});

test("answer bank and option matching", () => {
  assert.equal(answerFromBank(me.answers, "Will you now or in the future require sponsorship?")?.id, "sponsorship");
  assert.equal(answerFromBank(me.answers, "What is your favorite color?"), null);
  assert.equal(pickOption(["Yes", "No"], "yes"), "Yes");
  assert.equal(pickOption(["I am a protected veteran", "I am not a protected veteran", "Decline to self-identify"], "Decline to self-identify"), "Decline to self-identify");
  assert.equal(pickOption(["Option A", "Option B"], "Option"), null);
});

test("JSON schema sent to the CLI is draft-07 without $schema", () => {
  const s = JSON.parse(cliSchema(LetterDraft));
  assert.equal(s.$schema, undefined);
  assert.equal(s.type, "object");
});

test("cover letter pipeline drafts, humanizes, checks, and versions", async () => {
  const db = openDb(":memory:");
  const t = now();
  db.prepare("INSERT INTO jobs (id, source, title, employer, fingerprint, first_seen_at, last_seen_at, updated_at) VALUES (?, 'nuworks', 'Backend Co-op', 'Lumen Health', 'x', ?, ?, ?)").run(posting.id, t, t, t);
  const brain = new FakeBrain((req) => {
    if (req.purpose.startsWith("letter:")) return { body: LETTER, claims: [{ text: "built a tracker", sourceId: "proj-tracker-1" }] };
    if (req.purpose.startsWith("humanize:")) {
      assert.match(req.system, /Humanizer/); // the plugin's real SKILL.md is the system prompt
      return { text: LETTER.replace("Dear", "Hi"), changes: ["warmer greeting"] };
    }
    throw new Error(`unexpected ${req.purpose}`);
  });
  const w1 = await writeCoverLetter({ brain, me, posting, db });
  assert.equal(w1.lint.ok, true, w1.lint.problems.join("; "));
  assert.ok(w1.body.startsWith("Hi"));
  const w2 = await writeCoverLetter({ brain, me, posting, db });
  const rows = db.prepare("SELECT version, is_current FROM writings WHERE job_id = ? ORDER BY version").all(posting.id) as { version: number; is_current: number }[];
  assert.deepEqual(rows.map((r) => [r.version, r.is_current]), [[1, 0], [2, 1]]);
  assert.ok(w2.id && w2.id > w1.id!);
  assert.ok(letterHtml({ profile: me.profile, employer: "<b>Evil</b>", title: "t", body: w1.body, date: "d" }).includes("&lt;b&gt;Evil"));
});

test("an answer the AI can't support is flagged and not humanized", async () => {
  const brain = new FakeBrain((req) => {
    if (req.purpose.startsWith("answer:")) return { answer: "", claims: [], confidence: "low", needsHuman: true, reason: "salary expectations not in profile" };
    throw new Error("humanizer should not run");
  });
  const w = await writeAnswer({ brain, me, posting, question: "What are your salary expectations?" });
  assert.equal(w.needsHuman, true);
  assert.equal(w.lint.ok, false);
});
