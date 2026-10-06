// A posting from a GitHub job-list repo (Track B), normalized across repo formats.

export type Sponsorship = "offers" | "does_not_offer" | "us_citizen_only" | "unknown";

export interface Listing {
  repo: string; // "owner/name"
  sourceId: string; // stable id within the repo (listing id, or hash of company+title+url)
  company: string;
  title: string;
  locations: string[];
  terms: string[]; // e.g. ["Spring 2027"], ["Summer 2027"], ["Fall 2026"]
  applyUrl: string; // direct link to the application (tracking params removed)
  postedAt: string | null; // ISO 8601
  active: boolean;
  sponsorship: Sponsorship;
  degrees: string[]; // e.g. ["Bachelor's"], empty if unknown
  category: string | null; // e.g. "Software Engineering", "Data Science"
  raw: unknown;
}

export interface SourceParser {
  // True if this parser understands the checked-out repo at `dir`.
  detect(dir: string): boolean;
  parse(dir: string, repo: string): Listing[];
}
