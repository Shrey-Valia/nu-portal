import { pullRepo } from "./git-source.js";
import { markdownTableParser } from "./markdown-table.js";
import { listingFingerprint } from "./normalize.js";
import { simplifyJsonParser } from "./simplify-json.js";
import type { Listing, SourceParser } from "./types.js";

// Structured data first; README tables are the fallback.
export const PARSERS: readonly (SourceParser & { name: string })[] = [simplifyJsonParser, markdownTableParser];

// One posting per apply URL. Rows without a link (closed markdown rows) fall back to fingerprint + terms.
export function dedupeListings(listings: Listing[]): Listing[] {
  const byKey = new Map<string, Listing>();
  for (const l of listings) {
    const key = l.applyUrl || `closed:${listingFingerprint(l)}|${l.terms.join(",")}`;
    const seen = byKey.get(key);
    if (!seen) {
      byKey.set(key, { ...l });
      continue;
    }
    // The same posting listed twice (e.g. under two term headings): keep one, remember both.
    seen.terms = [...new Set([...seen.terms, ...l.terms])];
    seen.locations = [...new Set([...seen.locations, ...l.locations])];
    seen.active ||= l.active;
  }
  return [...byKey.values()];
}

export function parserFor(dir: string): (SourceParser & { name: string }) | undefined {
  return PARSERS.find((p) => p.detect(dir));
}

export function parseRepoDir(dir: string, repo: string): Listing[] {
  const parser = parserFor(dir);
  if (!parser) {
    throw new Error(
      `${repo}: no job list found. Expected .github/scripts/listings.json or a README table with Company and Role columns.`,
    );
  }
  return dedupeListings(parser.parse(dir, repo));
}

export async function pullAndParse(repo: string): Promise<{ listings: Listing[]; sha: string; repo: string }> {
  const pulled = await pullRepo(repo);
  return { listings: parseRepoDir(pulled.dir, pulled.repo), sha: pulled.sha, repo: pulled.repo };
}

// Counts for a CLI summary: { "Summer 2027": { total, active }, ... }, "(none)" for listings without a term.
export function countByTerm(listings: Listing[]): Record<string, { total: number; active: number }> {
  const counts: Record<string, { total: number; active: number }> = {};
  for (const l of listings) {
    for (const term of l.terms.length ? l.terms : ["(none)"]) {
      const c = (counts[term] ??= { total: 0, active: 0 });
      c.total++;
      if (l.active) c.active++;
    }
  }
  return counts;
}
