import type { Listing, Sponsorship } from "./types.js";

export function normalizeSpace(text: string): string {
  return text.replace(/[\s ​]+/g, " ").trim();
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, e: string) => {
    if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? match;
    const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
  });
}

// Markers like 🔒 🛂 🇺🇸 🎓 🔥 are read before this runs; here they are just noise.
export function stripEmoji(text: string): string {
  return text.replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}]/gu, "");
}

const ALWAYS_STRIP = /^(utm_.*|gh_src|gclid|fbclid|mc_cid|mc_eid|_hsenc|_hsmi)$/;
// These keys mean something real on some ATSs, so only drop them when they name a job board.
const BOARD_KEYS = /^(ref|source|src|iis|iisn|gns|lever-source(\[\])?)$/;
const BOARD_VALUES = /simplify|github|ghlist|linkedin|indeed|glassdoor|handshake|jobright/i;

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, " "));
  } catch {
    return text;
  }
}

function isTrackingParam(pair: string): boolean {
  const eq = pair.indexOf("=");
  const key = safeDecode(eq < 0 ? pair : pair.slice(0, eq)).toLowerCase();
  const value = eq < 0 ? "" : safeDecode(pair.slice(eq + 1));
  return ALWAYS_STRIP.test(key) || (BOARD_KEYS.test(key) && BOARD_VALUES.test(value));
}

const stripTracking = (query: string) =>
  query
    .split("&")
    .filter((p) => p && !isTrackingParam(p))
    .join("&");

// Edits the query as text instead of round-tripping through URLSearchParams, which
// re-encodes values and can break ATS links that are picky about their query strings.
export function cleanApplyUrl(raw: string): string {
  const text = decodeEntities(raw).trim();
  if (!/^https?:\/\//i.test(text)) return text;
  const hashAt = text.indexOf("#");
  const main = hashAt < 0 ? text : text.slice(0, hashAt);
  let hash = hashAt < 0 ? "" : text.slice(hashAt + 1);
  const q = main.indexOf("?");
  const base = q < 0 ? main : main.slice(0, q);
  const query = q < 0 ? "" : stripTracking(main.slice(q + 1));
  // Simplify appends "&utm_source=Simplify&ref=Simplify" to the raw URL, so it can land inside the fragment.
  const sep = hash.search(/[?&]/);
  if (sep >= 0) {
    const rest = stripTracking(hash.slice(sep + 1));
    hash = hash.slice(0, sep) + (rest ? hash[sep] + rest : "");
  }
  return base + (query ? `?${query}` : "") + (hash ? `#${hash}` : "");
}

type Season = "Spring" | "Summer" | "Fall" | "Winter";
const SEASONS: Record<string, Season> = { spring: "Spring", summer: "Summer", fall: "Fall", autumn: "Fall", winter: "Winter" };
const SEASON_START_MONTH: Record<Season, number> = { Winter: 0, Spring: 0, Summer: 4, Fall: 8 };
const TERM_RE = /(?<![a-z])(spring|summer|fall|autumn|winter)(?![a-z])(?:[\s_,-]*(20\d{2}|'\d{2})(?!\d))?/gi;
const OFF_SEASON_RE = /(?<![a-z])off[\s_-]?season(?![a-z])/i;

// A bare season ("Fall") means the next one that starts on or after `ref` (usually the posting date).
function inferYear(season: Season, ref: Date): number {
  const year = ref.getUTCFullYear();
  return ref.getUTCMonth() <= SEASON_START_MONTH[season] ? year : year + 1;
}

// "Summer 2027" | "Winter 2027, Spring 2027" | "Spring/Summer 2027" | "Fall '26" | "Summer2026" -> ["Summer 2027", ...].
export function parseTerms(text: string, ref?: Date | null): string[] {
  const found = [...text.matchAll(TERM_RE)].map((m) => ({
    season: SEASONS[m[1].toLowerCase()],
    year: m[2] ? (m[2].startsWith("'") ? 2000 + Number(m[2].slice(1)) : Number(m[2])) : null,
  }));
  const out = found.map((f, i) => {
    // "Spring & Fall 2026": a bare season takes the next year written after it.
    const year = f.year ?? found.slice(i + 1).find((g) => g.year)?.year ?? (ref ? inferYear(f.season, ref) : null);
    return year ? `${f.season} ${year}` : f.season;
  });
  if (!out.length && OFF_SEASON_RE.test(text)) out.push("Off-Season");
  return [...new Set(out)];
}

// Headings and file names only count when they name a year (or "Off-Season"), so prose like
// "Don't fall behind" is never read as a term.
export function termsFromHeading(text: string): string[] {
  return parseTerms(text).filter((t) => /\d{4}$/.test(t) || t === "Off-Season");
}

export function isCoop(text: string): boolean {
  return /\bco-?op\b/i.test(text);
}

const CATEGORY_RULES: [RegExp, string][] = [
  [/hardware/i, "Hardware Engineering"],
  [/quant/i, "Quantitative Finance"],
  [/product/i, "Product Management"],
  [/\bdata\b|machine learning|\bai\b|\bml\b/i, "Data Science, AI & Machine Learning"],
  [/software|\bswe\b/i, "Software Engineering"],
];

export function knownCategory(text: string): string | null {
  return CATEGORY_RULES.find(([re]) => re.test(text))?.[1] ?? null;
}

// Simplify mixes short keys ("AI/ML/Data") with display names; map both to the display name.
export function normalizeCategory(raw: unknown): string | null {
  const text = typeof raw === "string" ? normalizeSpace(raw) : "";
  return text ? knownCategory(text) ?? text : null;
}

export function normalizeSponsorship(raw: unknown): Sponsorship {
  const text = typeof raw === "string" ? raw.toLowerCase() : "";
  if (/citizen/.test(text)) return "us_citizen_only";
  if (/\b(not|no|doesn't|won't)\b.*sponsor/.test(text)) return "does_not_offer";
  if (/sponsor/.test(text)) return "offers";
  return "unknown";
}

const DAY = 86_400_000;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// "0d" | "3d" | "2w" | "1mo" | "Aug 21" | "2026-08-21" -> ISO date, relative to `ref` (the commit date).
export function parseAge(text: string, ref: Date): string | null {
  const t = normalizeSpace(text).toLowerCase();
  let m = t.match(/^(\d+)\s*(h|hrs?|hours?|d|days?|w|wks?|weeks?|mo|mos|months?|y|yrs?|years?)(\s+ago)?$/);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2];
    const ms = unit.startsWith("h")
      ? n * 3_600_000
      : unit.startsWith("d")
        ? n * DAY
        : unit.startsWith("w")
          ? n * 7 * DAY
          : unit.startsWith("m")
            ? n * 30 * DAY
            : n * 365 * DAY;
    return new Date(ref.getTime() - ms).toISOString();
  }
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toISOString();
  m = t.match(/^([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?$/);
  if (m && MONTHS.includes(m[1])) {
    const month = MONTHS.indexOf(m[1]);
    const day = Number(m[2]);
    const year = m[3] ? Number(m[3]) : ref.getUTCFullYear();
    let at = Date.UTC(year, month, day);
    // Lists print "Aug 21" with no year; a date after the reference must be from last year.
    if (!m[3] && at > ref.getTime() + 2 * DAY) at = Date.UTC(year - 1, month, day);
    return new Date(at).toISOString();
  }
  return null;
}

export function fingerprintPart(text: string): string {
  return normalizeSpace(
    text
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ""),
  );
}

// company|title|first location, so the same posting matches across repos and NUworks.
export function listingFingerprint(l: Pick<Listing, "company" | "title" | "locations">): string {
  return [l.company, l.title, l.locations[0] ?? ""].map(fingerprintPart).join("|");
}
