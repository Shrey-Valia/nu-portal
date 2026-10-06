import { humanize } from "../brain/humanizer.js";
import type { PostingForPrompt } from "../brain/prompts/context.js";
import { ANSWER_PROMPT_VERSION, TextAnswer, textAnswerPrompt } from "../brain/prompts/answer.js";
import { LETTER_PROMPT_VERSION, LetterDraft, letterPrompt } from "../brain/prompts/letter.js";
import type { Brain } from "../brain/types.js";
import { type Db, json, now, tx } from "../db/db.js";
import { checkClaims, type LintResult, lintWriting } from "../letters/lint.js";
import { knownSourceIds, type Me, profileForBrain } from "../me/load.js";

// Every cover letter and written answer: AI draft → humanizer → checks → saved
// as a new version. Checks run again after the humanizer because it must not
// add or drop facts.

export interface Writing {
  id: number | null; // null when not stored (samples)
  kind: "cover_letter" | "answer";
  question: string | null;
  draft: string;
  body: string;
  claims: { text: string; sourceId: string }[];
  lint: LintResult;
  humanizerChanges: string[];
  needsHuman: boolean; // the AI said it lacks information (answers only)
  model: string;
}

interface Common {
  brain: Brain;
  me: Me;
  posting: PostingForPrompt;
  db?: Db; // omit to skip saving
  runId?: number | null;
}

export async function writeCoverLetter(opts: Common): Promise<Writing> {
  const { brain, me, posting } = opts;
  const known = knownSourceIds(me);
  let feedback: string[] | undefined;
  let last: Writing | undefined;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const { system, prompt } = letterPrompt(me, posting, feedback);
    const { data: draft, meta } = await brain.structured({ purpose: `letter:${posting.id}`, system, prompt, schema: LetterDraft, tier: "write", runId: opts.runId });
    const claimProblems = checkClaims(draft.claims, known);
    const facts = factsFor(me, posting, draft.claims);
    const human = await humanize(brain, { text: draft.body, kind: "cover letter", voice: me.voice, facts }, opts.runId);
    const lint = lintWriting(human.text, { kind: "cover_letter", employer: posting.employer, sources: [draft.body, facts, posting.description] });
    lint.problems.unshift(...claimProblems);
    lint.ok = lint.problems.length === 0;
    last = { id: null, kind: "cover_letter", question: null, draft: draft.body, body: human.text, claims: draft.claims, lint, humanizerChanges: human.changes, needsHuman: false, model: meta.model };
    if (lint.ok) break;
    feedback = lint.problems;
  }
  return opts.db ? save(opts.db, posting.id, last!, LETTER_PROMPT_VERSION) : last!;
}

export async function writeAnswer(opts: Common & { question: string; maxChars?: number }): Promise<Writing> {
  const { brain, me, posting, question } = opts;
  const { system, prompt } = textAnswerPrompt(me, posting, question, opts.maxChars);
  const { data, meta } = await brain.structured({ purpose: `answer:${posting.id}`, system, prompt, schema: TextAnswer, tier: "write", runId: opts.runId });
  const facts = factsFor(me, posting, data.claims);
  let body = data.answer;
  let changes: string[] = [];
  if (!data.needsHuman && body.trim()) {
    const human = await humanize(brain, { text: body, kind: "application answer", voice: me.voice, facts }, opts.runId);
    body = human.text;
    changes = human.changes;
  }
  const lint = lintWriting(body, { kind: "answer", maxChars: opts.maxChars, sources: [data.answer, facts, posting.description, question] });
  lint.problems.unshift(...checkClaims(data.claims, knownSourceIds(me)));
  if (data.confidence === "low") lint.problems.push("AI confidence is low");
  lint.ok = lint.problems.length === 0;
  const w: Writing = { id: null, kind: "answer", question, draft: data.answer, body, claims: data.claims, lint, humanizerChanges: changes, needsHuman: data.needsHuman, model: meta.model };
  return opts.db ? save(opts.db, posting.id, w, ANSWER_PROMPT_VERSION) : w;
}

// The cited facts plus basics, so the humanizer knows what it may keep.
function factsFor(me: Me, posting: PostingForPrompt, claims: { text: string }[]): string {
  return [
    `Applying to: ${posting.title} at ${posting.employer}`,
    `Student: ${profileForBrain(me).slice(0, 4000)}`,
    ...claims.map((c) => `- ${c.text}`),
  ].join("\n");
}

function save(db: Db, jobId: string, w: Writing, promptVersion: string): Writing {
  return tx(db, () => {
    const scope = w.kind === "answer" ? "kind = 'answer' AND question = ?" : "kind = 'cover_letter'";
    const args = w.kind === "answer" ? [jobId, w.question] : [jobId];
    const prev = db.prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM writings WHERE job_id = ? AND ${scope}`).get(...(args as string[])) as { v: number };
    db.prepare(`UPDATE writings SET is_current = 0 WHERE job_id = ? AND ${scope}`).run(...(args as string[]));
    const r = db
      .prepare(
        "INSERT INTO writings (job_id, kind, question, version, source, draft, body, claims, lint, is_current, model, prompt_version, created_at) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, 1, ?, ?, ?)",
      )
      .run(jobId, w.kind, w.question, prev.v + 1, w.draft, w.body, json(w.claims), json(w.lint), w.model, promptVersion, now());
    return { ...w, id: Number(r.lastInsertRowid) };
  });
}
