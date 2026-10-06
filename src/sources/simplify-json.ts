import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { shortHash } from "../core/util.js";
import { cleanApplyUrl, normalizeCategory, normalizeSpace, normalizeSponsorship, parseTerms } from "./normalize.js";
import type { Listing, SourceParser } from "./types.js";

// SimplifyJobs repos (and community forks of their scripts) keep the source of truth here;
// the README tables are generated from it.
export const SIMPLIFY_LISTINGS_PATH = path.join(".github", "scripts", "listings.json");

export interface SimplifyEntry {
  id?: string;
  company_name?: string;
  title?: string;
  locations?: string[];
  url?: string;
  date_posted?: number; // epoch seconds
  active?: boolean;
  is_visible?: boolean;
  sponsorship?: string; // "Offers Sponsorship" | "Does Not Offer Sponsorship" | "U.S. Citizenship is Required" | "Other"
  terms?: string[]; // Simplify: ["Summer 2027"], ["N/A"]
  season?: string | null; // older forks: "Summer" | "Fall" | "Spring/Summer", no year
  degrees?: string[];
  category?: string;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function fromSimplifyEntry(e: SimplifyEntry, repo: string): Listing | null {
  if (e.is_visible === false) return null;
  const company = normalizeSpace(e.company_name ?? "");
  const title = normalizeSpace(e.title ?? "");
  if (!company || !title) return null;
  const applyUrl = cleanApplyUrl(e.url ?? "");
  const secs = typeof e.date_posted === "number" && e.date_posted > 0 ? e.date_posted : null;
  const posted = secs ? new Date(secs < 1e12 ? secs * 1000 : secs) : null;
  const termTexts = Array.isArray(e.terms) ? strings(e.terms) : typeof e.season === "string" ? [e.season] : [];
  return {
    repo,
    sourceId: e.id ? String(e.id) : shortHash(`${company}|${title}|${applyUrl}`),
    company,
    title,
    locations: [...new Set(strings(e.locations).map(normalizeSpace).filter(Boolean))],
    terms: [...new Set(termTexts.flatMap((t) => parseTerms(t, posted)))],
    applyUrl,
    postedAt: posted?.toISOString() ?? null,
    active: Boolean(e.active),
    sponsorship: normalizeSponsorship(e.sponsorship),
    degrees: strings(e.degrees).map(normalizeSpace),
    category: normalizeCategory(e.category),
    raw: e,
  };
}

export const simplifyJsonParser = {
  name: "simplify-json",
  detect: (dir: string) => existsSync(path.join(dir, SIMPLIFY_LISTINGS_PATH)),
  parse(dir: string, repo: string): Listing[] {
    const file = path.join(dir, SIMPLIFY_LISTINGS_PATH);
    const data: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(data)) throw new Error(`${repo}: ${SIMPLIFY_LISTINGS_PATH} is not a JSON array`);
    return data.flatMap((e) => (e && typeof e === "object" ? (fromSimplifyEntry(e as SimplifyEntry, repo) ?? []) : []));
  },
} satisfies SourceParser & { name: string };
