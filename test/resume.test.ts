import "./helpers.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { ROOT, LETTERS_DIR } from "../src/config/paths.js";
import { ProfileSchema } from "../src/me/schema.js";
import { checkTailored, pageCount, renderResume, resumeFileName } from "../src/resume/tailor.js";
import { resumeHtml, untailored } from "../src/resume/template.js";

const base = ProfileSchema.parse(parse(readFileSync(path.join(ROOT, "templates", "me", "profile.example.yaml"), "utf8")));
const profile = ProfileSchema.parse({
  ...base,
  skills: [...base.skills, { id: "sql", name: "SQL", level: "working" }, { id: "react", name: "React", level: "working" }],
  experiences: [
    ...base.experiences,
    { id: "ta", kind: "job", title: "Teaching Assistant", org: "Northeastern", start: "2025-09", bullets: [{ id: "ta-1", text: "Ran weekly labs for 40 students." }, { id: "ta-2", text: "Graded problem sets." }] },
  ],
});

test("tailoring keeps only true skills and traceable, number-safe bullets", () => {
  const { content, reverted } = checkTailored(profile, {
    skillGroups: [
      { label: "Languages", skills: ["python", "Rust", "TypeScript", "Python"] }, // Rust isn't yours; duplicate Python dropped
      { label: "Data", skills: ["SQL"] },
    ],
    experiences: [
      { experienceId: "ta", bullets: [
        { sourceId: "ta-2", text: "Graded weekly problem sets and gave written feedback." }, // reworded, kept
        { sourceId: "ta-1", text: "Ran weekly labs for 120 students." }, // new number -> reverted
        { sourceId: "proj-tracker-1", text: "Stolen from another job" }, // not this experience's bullet -> ignored
      ] },
      // proj-tracker missing entirely -> original bullets kept
    ],
    changes: ["Moved Python first"],
  });
  assert.deepEqual(content.skillGroups, [{ label: "Languages", skills: ["Python", "TypeScript"] }, { label: "Data", skills: ["SQL"] }]);
  assert.deepEqual(content.bullets.ta, ["Graded weekly problem sets and gave written feedback.", "Ran weekly labs for 40 students."]);
  assert.deepEqual(content.bullets["proj-tracker"], [profile.experiences[0].bullets[0].text]);
  assert.equal(reverted.length, 1);
  assert.match(reverted[0], /new number 120/);
});

test("resume renders to one page and escapes text", async () => {
  const html = resumeHtml({ ...profile, identity: { ...profile.identity, name: "<b>Jane</b>" } }, untailored(profile));
  assert.ok(html.includes("&lt;b&gt;Jane"));
  assert.equal(resumeFileName(profile, "Acme / Robotics, Inc."), "Jane Husky Resume - Acme Robotics Inc..pdf");
  const out = path.join(LETTERS_DIR, "resumes", "test", "r.pdf");
  await renderResume(profile, untailored(profile), out);
  assert.equal(pageCount(out), 1);
});
