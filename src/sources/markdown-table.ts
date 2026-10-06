import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { shortHash } from "../core/util.js";
import {
  cleanApplyUrl,
  decodeEntities,
  knownCategory,
  listingFingerprint,
  normalizeSpace,
  parseAge,
  parseTerms,
  stripEmoji,
  termsFromHeading,
} from "./normalize.js";
import type { Listing, SourceParser, Sponsorship } from "./types.js";

// Fallback for job-list repos that only publish README tables (pipe tables or Simplify-style
// HTML tables). Columns are found by header name, so column order doesn't matter.

type Column = "company" | "title" | "location" | "terms" | "apply" | "age";

// Order matters: each column claims the first unclaimed header that matches.
const COLUMN_PATTERNS: [Column, RegExp][] = [
  ["company", /\b(company|employer|organi[sz]ation)\b/],
  ["location", /\blocations?\b/],
  ["terms", /\b(terms?|seasons?)\b/],
  ["age", /\b(age|date|posted)\b/],
  ["apply", /\b(appl\w*|link|posting|url)\b/],
  ["title", /\b(role|title|position|job)\b/],
];

interface Table {
  headers: string[];
  rows: string[][]; // raw cell HTML/markdown
  terms: string[]; // from the nearest heading that names a term
  category: string | null;
}

const ADVANCED_DEGREES = ["Master's", "PhD", "MBA"];
const SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/;
const BR = /<br\s*\/?>|<\/br>/gi;
const IMAGE_URL = /\.(png|jpe?g|gif|svg|webp)(\?|$)|imgur\.com|shields\.io/i;

function cellText(cell: string): string {
  return normalizeSpace(
    stripEmoji(
      decodeEntities(
        cell
          .replace(/<summary\b[\s\S]*?<\/summary>/gi, " ")
          .replace(BR, " ")
          .replace(/<[^>]+>/g, "")
          .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
          .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
          .replace(/\*\*|__|~~/g, ""),
      ),
    ),
  );
}

function cellLocations(cell: string): string[] {
  const body = cell.replace(/<summary\b[\s\S]*?<\/summary>/gi, "");
  return [...new Set(body.split(BR).map(cellText).filter(Boolean))];
}

// Links in document order, from <a href> and [text](url); badge images are dropped.
function cellLinks(cell: string): string[] {
  return [...cell.matchAll(/<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["']|\]\((https?:\/\/[^)\s]+)\)/gi)]
    .map((m) => decodeEntities((m[1] ?? m[2]).trim()))
    .filter((u) => /^https?:\/\//i.test(u) && !IMAGE_URL.test(u));
}

function splitPipeRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.replace(/\\\|/g, "|").trim());
}

function htmlTable(block: string): { headers: string[]; rows: string[][] } {
  let headers: string[] = [];
  const rows: string[][] = [];
  for (const tr of block.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1].matchAll(/<(t[hd])\b[^>]*>([\s\S]*?)<\/\1>/gi)];
    if (!cells.length) continue;
    if (!headers.length && cells.every((c) => c[1].toLowerCase() === "th")) headers = cells.map((c) => cellText(c[2]));
    else rows.push(cells.map((c) => c[2]));
  }
  return { headers, rows };
}

// Tables in document order, each tagged with the term/category of the headings above it.
// Headings are scoped like sections: a "## Fall 2026" ends the previous "## ..." section.
export function readTables(md: string): Table[] {
  const lines = md.split(/\r?\n/);
  const tables: Table[] = [];
  const stack: { level: number; terms: string[]; category: string | null }[] = [];
  const context = () => {
    const rev = [...stack].reverse();
    return { terms: rev.find((s) => s.terms.length)?.terms ?? [], category: rev.find((s) => s.category)?.category ?? null };
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const hashes = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    const html = hashes ? null : line.match(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/i);
    if (hashes || html) {
      const level = hashes ? hashes[1].length : Number(html![1]);
      const text = cellText(hashes ? hashes[2] : html![2]);
      const entry = { level, terms: termsFromHeading(text), category: knownCategory(text) };
      // Banner/notice <hN> tags inside HTML blocks (e.g. GitHub's size-cutoff notice) aren't sections.
      if (html && !entry.terms.length && !entry.category) continue;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push(entry);
      continue;
    }
    if (/<table\b/i.test(line)) {
      const start = i;
      while (!/<\/table>/i.test(lines[i]) && i + 1 < lines.length) i++;
      tables.push({ ...htmlTable(lines.slice(start, i + 1).join("\n")), ...context() });
      continue;
    }
    if (line.trim().startsWith("|") && SEPARATOR.test(lines[i + 1] ?? "")) {
      const headers = splitPipeRow(line).map(cellText);
      const rows: string[][] = [];
      i++;
      while (i + 1 < lines.length && lines[i + 1].trim().startsWith("|")) rows.push(splitPipeRow(lines[++i]));
      tables.push({ headers, rows, ...context() });
    }
  }
  return tables;
}

const columnsCache = new WeakMap<string[], Partial<Record<Column, number>>>();

function mapColumns(headers: string[]): Partial<Record<Column, number>> {
  const hit = columnsCache.get(headers);
  if (hit) return hit;
  const cols: Partial<Record<Column, number>> = {};
  const used = new Set<number>();
  for (const [col, re] of COLUMN_PATTERNS) {
    const i = headers.findIndex((h, j) => !used.has(j) && re.test(h.toLowerCase()));
    if (i >= 0) {
      cols[col] = i;
      used.add(i);
    }
  }
  columnsCache.set(headers, cols);
  return cols;
}

const usable = (t: Table) => {
  const cols = mapColumns(t.headers);
  return cols.company !== undefined && cols.title !== undefined;
};

// Top-level README-style files. Inactive/archived lists only repeat closed rows with no links.
function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const isMain = (f: string) => Number(f.toLowerCase() === "readme.md");
  return readdirSync(dir)
    .filter((f) => /\.md$/i.test(f) && /readme/i.test(f) && !/inactive|archive/i.test(f))
    .sort((a, b) => isMain(b) - isMain(a) || a.localeCompare(b));
}

// Ages like "3d" are relative to when the README was generated, which is roughly the commit time.
function commitDate(dir: string): Date | null {
  // Only ask git about this checkout, never an enclosing repo.
  if (!existsSync(path.join(dir, ".git"))) return null;
  try {
    const out = execFileSync("git", ["-C", dir, "log", "-1", "--format=%cI"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const d = new Date(out.trim());
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

function sponsorshipOf(titleCell: string, title: string): Sponsorship {
  if (titleCell.includes("🇺🇸") || /u\.?s\.? citizen/i.test(title)) return "us_citizen_only";
  if (titleCell.includes("🛂") || /no sponsorship|not (offer|provide) sponsorship/i.test(title)) return "does_not_offer";
  return "unknown";
}

export function parseMarkdownDir(dir: string, repo: string, ref: Date = commitDate(dir) ?? new Date()): Listing[] {
  const repoTerms = termsFromHeading(repo.split("/").pop() ?? repo);
  const out: Listing[] = [];
  for (const file of listFiles(dir)) {
    const fileTerms = termsFromHeading(file);
    let prevCompany = "";
    // Simplify's GitHub-size-cutoff notice reopens the table with a hardcoded 5-column header,
    // even in the 6-column Off-Season README, so a row can be wider than its own header.
    const headersByWidth = new Map<number, string[]>();
    for (const table of readTables(readFileSync(path.join(dir, file), "utf8"))) {
      if (!usable(table)) continue;
      headersByWidth.set(table.headers.length, table.headers);
      for (const row of table.rows) {
        const headers = row.length === table.headers.length ? table.headers : (headersByWidth.get(row.length) ?? table.headers);
        const cols = mapColumns(headers);
        const get = (r: string[], col: Column) => (cols[col] === undefined ? "" : (r[cols[col]!] ?? ""));
        const companyCell = get(row, "company");
        const titleCell = get(row, "title");
        const applyCell = get(row, "apply");
        // "↳" means same company as the row above.
        const continued = cellText(companyCell) === "↳";
        const company = continued ? prevCompany : cellText(companyCell);
        if (!continued) prevCompany = company;
        const title = cellText(titleCell);
        if (!company || !title) continue;

        let links = cellLinks(applyCell);
        if (!links.length) links = cellLinks(titleCell);
        const applyUrl = cleanApplyUrl(links.find((u) => !/simplify\.jobs\//i.test(u)) ?? links[0] ?? "");
        const closed = [companyCell, titleCell, applyCell].some((c) => c.includes("🔒")) || /\bclosed\b/i.test(cellText(applyCell));
        const postedAt = parseAge(cellText(get(row, "age")), ref);
        const termCell = cellText(get(row, "terms"));
        const terms = [termCell ? parseTerms(termCell, postedAt ? new Date(postedAt) : ref) : [], table.terms, fileTerms, repoTerms].find((t) => t.length) ?? [];
        const locations = cellLocations(get(row, "location"));
        const simplifyId = row.join(" ").match(/simplify\.jobs\/p\/([0-9a-f-]{36})/i)?.[1];
        const listing: Listing = {
          repo,
          sourceId: "",
          company,
          title,
          locations,
          terms,
          applyUrl,
          postedAt,
          active: Boolean(applyUrl) && !closed,
          sponsorship: sponsorshipOf(titleCell, title),
          degrees: titleCell.includes("🎓") ? [...ADVANCED_DEGREES] : [],
          category: table.category,
          raw: { file, row: Object.fromEntries(headers.map((h, i) => [h, row[i] ?? ""])) },
        };
        // Closed rows lose their link, so fall back to what's left to keep the id stable-ish.
        listing.sourceId =
          simplifyId ?? shortHash(applyUrl ? `${company}|${title}|${applyUrl}` : `${listingFingerprint(listing)}|${terms.join(",")}`);
        out.push(listing);
      }
    }
  }
  return out;
}

export const markdownTableParser = {
  name: "markdown-table",
  detect: (dir: string) => listFiles(dir).some((f) => readTables(readFileSync(path.join(dir, f), "utf8")).some(usable)),
  parse: (dir: string, repo: string) => parseMarkdownDir(dir, repo),
} satisfies SourceParser & { name: string };
