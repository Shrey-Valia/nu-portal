import { z } from "zod";
import type { Me } from "../../me/load.js";
import { candidateBlock, NEUTRAL_RULE, type PostingForPrompt, postingBlock, UNTRUSTED_RULE } from "./context.js";

export const RESUME_PROMPT_VERSION = "resume-v1";

export const TailoredResume = z.object({
  skillGroups: z
    .array(z.object({ label: z.string().describe('e.g. "Languages", "ML & Data", "Tools"'), skills: z.array(z.string()) }))
    .describe("2-4 groups, most relevant group first, most relevant skills first. Only skill names from the profile."),
  experiences: z
    .array(
      z.object({
        experienceId: z.string(),
        bullets: z.array(z.object({ sourceId: z.string().describe("The profile bullet id this line comes from"), text: z.string() })),
      }),
    )
    .describe("Every experience from the profile, in the same order. Bullets reordered most relevant first."),
  changes: z.array(z.string()).describe("Plain-language notes on what you moved up or reworded and why"),
});
export type TailoredResume = z.infer<typeof TailoredResume>;

export function resumePrompt(me: Me, posting: PostingForPrompt) {
  const system = [
    "You tailor a student's resume to one job posting. You may only reorder and lightly reword what the student already has.",
    "Rules:",
    "- Skills: use only skill names that appear in <candidate>. Group them into 2-4 short groups; put the groups and skills this job cares about first. You may leave out a few clearly irrelevant skills.",
    "- Experiences: include every experience, in the order given. Within each, order bullets by relevance to this job.",
    "- Each bullet must come from one profile bullet (cite its id as sourceId). Keep its facts exactly: same numbers, tools, scope, and outcome. You may tighten wording or use the posting's term for something the bullet already shows (e.g. \"LLM\" for a bullet about GPT models). Never add a tool, number, result, or responsibility that isn't in the original bullet.",
    "- If a bullet can't be improved truthfully, return it unchanged.",
    "- Resume style: start bullets with a strong past-tense verb, no first person, no em dashes, under 30 words each.",
    NEUTRAL_RULE,
    UNTRUSTED_RULE,
  ].join("\n");
  const prompt = [candidateBlock(me, { preferences: false }), postingBlock(posting), `Tailor the resume for "${posting.title}" at ${posting.employer}.`].join("\n\n");
  return { system, prompt };
}
