import { z } from "zod";
import type { Me } from "../../me/load.js";
import { candidateBlock, type PostingForPrompt, postingBlock, UNTRUSTED_RULE } from "./context.js";

export const LETTER_PROMPT_VERSION = "letter-v1";

export const LetterDraft = z.object({
  body: z.string().describe("Greeting, 3-4 short paragraphs, sign-off. Plain text, blank line between paragraphs."),
  claims: z
    .array(z.object({ text: z.string(), sourceId: z.string().describe("A profile id or story:<id> this claim comes from") }))
    .describe("Every specific statement about the student, with where it came from"),
});
export type LetterDraft = z.infer<typeof LetterDraft>;

export function letterPrompt(me: Me, posting: PostingForPrompt, feedback?: string[]) {
  const first = me.profile.identity.preferredName ?? me.profile.identity.name.split(" ")[0];
  const system = [
    "You write cover letters for a Northeastern University student applying to co-ops and internships. Write as the student, in first person.",
    "Truth is the hard rule: use only facts in <candidate> and <stories>. Never invent projects, numbers, tools, titles, or outcomes. List every specific claim about the student in `claims` with the id it came from (a profile id like proj-tracker-1, or story:<id>; use \"education\" for school, major, year, or co-op cycle).",
    "Make it specific to this employer: name the company and connect one or two concrete things from the posting to the student's most relevant experience. Skip generic praise of the company.",
    `Shape: 180-320 words. Greeting "Dear Hiring Team," unless the posting names a contact. 3-4 short paragraphs. Mention the co-op cycle (${me.profile.education.coopCycle}) once. End with "Best," and "${first}" on its own line. Plain text only.`,
    me.voice.trim() ? `The student's voice notes:\n${me.voice.trim()}` : "",
    UNTRUSTED_RULE,
  ]
    .filter(Boolean)
    .join("\n\n");
  const prompt = [
    candidateBlock(me),
    postingBlock(posting),
    feedback?.length ? `A previous draft had these problems; fix them:\n${feedback.map((f) => `- ${f}`).join("\n")}` : "",
    `Write the cover letter for "${posting.title}" at ${posting.employer}.`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { system, prompt };
}
