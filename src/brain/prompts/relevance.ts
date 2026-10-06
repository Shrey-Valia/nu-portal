import { z } from "zod";
import { asData } from "../../core/sanitize.js";
import type { Me } from "../../me/load.js";
import { candidateBlock, UNTRUSTED_RULE } from "./context.js";

export const RELEVANCE_PROMPT_VERSION = "relevance-v1";

export const RelevanceResults = z.object({
  results: z.array(z.object({ id: z.string(), relevance: z.number().int().min(0).max(100), reason: z.string() })),
});

export interface ListingForPrompt {
  id: string;
  company: string;
  title: string;
  locations: string[];
  terms: string[];
  category: string | null;
}

// Cheap first pass for job-list postings: titles and basics only, no descriptions.
export function relevancePrompt(me: Me, listings: ListingForPrompt[]) {
  const system = [
    "You triage internship and co-op listings for one student. For each listing, rate 0-100 how relevant the role is to their target roles, skills, and interests, using only the title, company, location, term, and category.",
    "80+: squarely a role they want. 60-79: adjacent and worth applying. Below 60: a different field (e.g. sales, mechanical, nursing for a CS student) or clearly too senior.",
    UNTRUSTED_RULE.replace("<posting> or <question>", "<listing>"),
  ].join("\n\n");
  const prompt = [
    candidateBlock(me, { stories: false }),
    listings.map((l) => asData("listing", { id: l.id }, `${l.title} | ${l.company} | ${l.locations.slice(0, 3).join("; ")} | ${l.terms.join(", ")}${l.category ? ` | ${l.category}` : ""}`)).join("\n"),
    "Rate every listing. Return one result per id.",
  ].join("\n\n");
  return { system, prompt };
}
