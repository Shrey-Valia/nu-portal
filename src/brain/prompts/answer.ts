import { z } from "zod";
import { asData } from "../../core/sanitize.js";
import type { Me } from "../../me/load.js";
import { candidateBlock, type PostingForPrompt, postingBlock, UNTRUSTED_RULE } from "./context.js";

export const ANSWER_PROMPT_VERSION = "answer-v1";

export const TextAnswer = z.object({
  answer: z.string(),
  claims: z.array(z.object({ text: z.string(), sourceId: z.string() })),
  confidence: z.enum(["high", "medium", "low"]),
  needsHuman: z.boolean().describe("True if answering needs information the profile doesn't have, or a personal decision"),
  reason: z.string().describe("Why, in a few words"),
});
export type TextAnswer = z.infer<typeof TextAnswer>;

export const ChoiceAnswer = z.object({
  choice: z.string().nullable().describe("Exactly one of the given options, copied verbatim, or null"),
  confidence: z.enum(["high", "medium", "low"]),
  needsHuman: z.boolean(),
  reason: z.string(),
});
export type ChoiceAnswer = z.infer<typeof ChoiceAnswer>;

const SYSTEM = [
  "You fill in job application questions for a Northeastern University student, as the student, truthfully.",
  "Use only facts from <candidate>, <stories>, and <answer_bank>. Never invent experience, numbers, or personal details.",
  "Set needsHuman to true when the question needs something the profile doesn't say (salary expectations, references, a specific personal circumstance, legal attestations, anything you'd be guessing). It is far better to ask than to guess.",
  UNTRUSTED_RULE,
].join("\n\n");

function bank(me: Me): string {
  return me.answers.length ? `<answer_bank>\n${me.answers.map((a) => `- (${a.match.join(" / ")}) → ${a.answer}`).join("\n")}\n</answer_bank>` : "";
}

export function textAnswerPrompt(me: Me, posting: PostingForPrompt, question: string, maxChars?: number) {
  const prompt = [
    candidateBlock(me),
    bank(me),
    postingBlock(posting),
    asData("question", {}, question),
    `Answer the question for this application. ${maxChars ? `Stay under ${maxChars} characters. ` : ""}Plain text, first person, specific to ${posting.employer}. List every factual claim with its source id.`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { system: `${SYSTEM}\n\n${me.voice.trim() ? `Voice notes:\n${me.voice.trim()}` : ""}`, prompt };
}

export function choiceAnswerPrompt(me: Me, posting: PostingForPrompt, question: string, options: string[]) {
  const prompt = [
    candidateBlock(me, { stories: false }),
    bank(me),
    postingBlock(posting),
    asData("question", {}, `${question}\nOptions:\n${options.map((o) => `- ${o}`).join("\n")}`),
    "Pick the option that is true for this student. Copy it exactly. If none is clearly true, return null and set needsHuman.",
  ]
    .filter(Boolean)
    .join("\n\n");
  return { system: SYSTEM, prompt };
}
