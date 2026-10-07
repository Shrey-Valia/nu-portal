import { readFileSync } from "node:fs";
import path from "node:path";
import type { PostingForPrompt } from "../brain/prompts/context.js";
import { RESUME_PROMPT_VERSION, TailoredResume, resumePrompt } from "../brain/prompts/resume.js";
import type { Brain } from "../brain/types.js";
import { LETTERS_DIR } from "../config/paths.js";
import { type Db, json, now, tx } from "../db/db.js";
import { lintWriting } from "../letters/lint.js";
import { renderPdf } from "../letters/render-pdf.js";
import type { Me } from "../me/load.js";
import type { Profile } from "../me/schema.js";
import { type ResumeContent, resumeHtml, untailored } from "./template.js";

// A resume reordered and lightly reworded for one job. Every bullet must trace
// to your profile; anything that fails a check goes back to your wording.

export interface Tailored {
  id: number | null;
  content: ResumeContent;
  changes: string[];
  reverted: string[];
  pdfPath: string | null;
}

const numbers = (s: string) => new Set((s.match(/\d+(?:[.,]\d+)?%?/g) ?? []).map((n) => n.replace(/,/g, "")));

export function checkTailored(profile: Profile, data: TailoredResume): { content: ResumeContent; reverted: string[] } {
  const reverted: string[] = [];
  const canonical = new Map(profile.skills.map((s) => [s.name.toLowerCase(), s.name]));
  const used = new Set<string>();
  const skillGroups = data.skillGroups
    .map((g) => ({
      label: g.label.trim().slice(0, 40),
      skills: g.skills.map((s) => canonical.get(s.trim().toLowerCase())).filter((s): s is string => !!s && !used.has(s) && (used.add(s), true)),
    }))
    .filter((g) => g.label && g.skills.length);

  const bullets: Record<string, string[]> = {};
  for (const exp of profile.experiences) {
    const original = new Map(exp.bullets.map((b) => [b.id, b.text]));
    const tailored = data.experiences.find((e) => e.experienceId === exp.id)?.bullets ?? [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const b of tailored) {
      const src = original.get(b.sourceId);
      if (!src || seen.has(b.sourceId)) continue; // not this experience's bullet, or a duplicate
      seen.add(b.sourceId);
      const text = b.text.trim();
      const newNumbers = [...numbers(text)].filter((n) => !numbers(src).has(n));
      const tooLong = text.length > src.length * 1.6 + 25;
      const flagged = !lintWriting(text, { kind: "answer", maxChars: 400 }).ok;
      if (!text || newNumbers.length || tooLong || flagged) {
        out.push(src);
        reverted.push(`${exp.title}: kept your wording (${newNumbers.length ? `new number ${newNumbers.join(", ")}` : tooLong ? "rewrite was too long" : "rewrite failed a check"})`);
      } else out.push(text);
    }
    // Never drop facts: any bullet the model left out goes at the end, unchanged.
    for (const b of exp.bullets) if (!seen.has(b.id)) out.push(b.text);
    bullets[exp.id] = out;
  }
  return { content: { skillGroups: skillGroups.length ? skillGroups : untailored(profile).skillGroups, bullets }, reverted };
}

// Renders one page if it can, stepping the font down a little at a time.
export async function renderResume(profile: Profile, content: ResumeContent, out: string): Promise<string> {
  for (const pt of [10.5, 10, 9.5, 9]) {
    await renderPdf(resumeHtml(profile, content, pt), out);
    if (pageCount(out) <= 1) break;
  }
  return out;
}

export function pageCount(pdfPath: string): number {
  return (readFileSync(pdfPath).toString("latin1").match(/\/Type\s*\/Page(?!s)/g) ?? []).length;
}

export function resumeFileName(profile: Profile, employer: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9 &.-]+/g, "").replace(/\s+/g, " ").trim().slice(0, 50);
  return `${clean(profile.identity.name)} Resume - ${clean(employer) || "Tailored"}.pdf`;
}

export async function tailorResume(opts: { brain: Brain; me: Me; posting: PostingForPrompt; db?: Db; runId?: number | null }): Promise<Tailored> {
  const { brain, me, posting } = opts;
  const { system, prompt } = resumePrompt(me, posting);
  const { data, meta } = await brain.structured({ purpose: `resume:${posting.id}`, system, prompt, schema: TailoredResume, tier: "write", runId: opts.runId });
  const { content, reverted } = checkTailored(me.profile, data);
  const t: Tailored = { id: null, content, changes: data.changes.slice(0, 8), reverted, pdfPath: null };
  if (!opts.db) return t;
  const db = opts.db;
  return tx(db, () => {
    const v = (db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM resumes WHERE job_id = ?").get(posting.id) as { v: number }).v + 1;
    db.prepare("UPDATE resumes SET is_current = 0 WHERE job_id = ?").run(posting.id);
    const id = Number(
      db
        .prepare("INSERT INTO resumes (job_id, version, data, changes, reverted, is_current, model, prompt_version, profile_version, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)")
        .run(posting.id, v, json(content), json(t.changes), json(reverted), meta.model, RESUME_PROMPT_VERSION, me.version, now()).lastInsertRowid,
    );
    return { ...t, id };
  });
}

export function resumeDir(jobId: string): string {
  return path.join(LETTERS_DIR, "resumes", jobId.replace(/[^a-z0-9]+/gi, "_"));
}
