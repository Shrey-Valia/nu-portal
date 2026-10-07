import type { Profile } from "../me/schema.js";
import type { Sponsorship } from "../sources/types.js";
import { normalizeName } from "./dedupe.js";

// Deterministic eligibility + preference rules, applied before any AI call.
// Unknown information passes; only clear mismatches are filtered out.

export interface Qualifications {
  majors?: string[];
  // NUworks' own eligibility check for you (majors, level, GPA, authorization).
  nuworksQualified?: boolean;
  levels?: string[];
  minGpa?: number;
  citizenship?: "required" | null;
  sponsorship?: Sponsorship;
}

export interface JobFacts {
  track: "nuworks" | "external";
  title: string;
  employer: string;
  location: string | null;
  modality: string | null; // onsite | hybrid | remote | unknown
  terms: string[];
  deadlineAt: string | null;
  postedAt: string | null;
  payText: string | null;
  description: string;
  qualifications: Qualifications;
  fingerprint: string;
}

export interface FilterContext {
  now: Date;
  wantedTerms: string[]; // e.g. ["Spring 2027"]
  seenFingerprints: Set<string>; // already applied to, approved, or skipped
  employerCounts: Map<string, number>; // normalized employer -> applied/approved count
  maxPerEmployer: number;
  postedWithinDays?: number; // external only
}

export type FilterCode =
  | "duplicate"
  | "deadline_passed"
  | "wrong_term"
  | "citizenship"
  | "clearance"
  | "sponsorship"
  | "not_qualified"
  | "major"
  | "level"
  | "gpa"
  | "avoided_employer"
  | "avoided_keyword"
  | "unpaid"
  | "pay"
  | "modality"
  | "location"
  | "employer_limit"
  | "too_old";

export type FilterResult = { pass: true } | { pass: false; code: FilterCode; reason: string };

const fail = (code: FilterCode, reason: string): FilterResult => ({ pass: false, code, reason });

export function applyFilters(job: JobFacts, profile: Profile, ctx: FilterContext): FilterResult {
  const text = `${job.title}\n${job.description}`;
  const employerKey = normalizeName(job.employer);

  if (ctx.seenFingerprints.has(job.fingerprint)) return fail("duplicate", "same role already applied to or decided");

  if (job.deadlineAt && Date.parse(job.deadlineAt) < ctx.now.getTime()) return fail("deadline_passed", `deadline ${job.deadlineAt.slice(0, 10)} passed`);

  if (job.terms.length && ctx.wantedTerms.length && !job.terms.some((t) => ctx.wantedTerms.some((w) => sameTerm(t, w)))) {
    return fail("wrong_term", `term ${job.terms.join(", ")} (want ${ctx.wantedTerms.join(", ")})`);
  }

  const auth = profile.workAuth;
  const citizenRequired = job.qualifications.citizenship === "required" || job.qualifications.sponsorship === "us_citizen_only" || CITIZEN_RE.test(text);
  if (citizenRequired && auth.usCitizen === false) return fail("citizenship", "requires U.S. citizenship");
  if (CLEARANCE_RE.test(text) && auth.clearanceEligible === false) return fail("clearance", "requires a security clearance");
  const noSponsor = job.qualifications.sponsorship === "does_not_offer" || NO_SPONSOR_RE.test(text);
  if (noSponsor && auth.needsSponsorship) return fail("sponsorship", "does not sponsor visas");

  const q = job.qualifications;
  if (q.nuworksQualified === false) return fail("not_qualified", "NUworks says you don't meet this posting's requirements");
  if (q.nuworksQualified !== true && q.majors?.length && !q.majors.some((m) => /\b(all|any) (majors?|disciplines?)\b/i.test(m))) {
    const mine = profile.education.majors.map(normalizeName);
    const ok = q.majors.map(normalizeName).some((m) => mine.some((x) => x.includes(m) || m.includes(x)));
    if (!ok) return fail("major", `majors: ${q.majors.slice(0, 4).join(", ")}`);
  }
  if (q.levels?.length && profile.education.level) {
    const ok = q.levels.some((l) => normalizeName(l).includes(normalizeName(profile.education.level!)));
    if (!ok) return fail("level", `levels: ${q.levels.join(", ")}`);
  }
  if (q.minGpa && profile.education.gpa && profile.education.gpa < q.minGpa) return fail("gpa", `min GPA ${q.minGpa}`);

  const t = profile.targets;
  const avoided = t.companiesAvoid.find((c) => {
    const k = normalizeName(c);
    return k && (employerKey === k || employerKey.startsWith(`${k} `));
  });
  if (avoided) return fail("avoided_employer", `you avoid ${avoided}`);
  if (UNPAID_RE.test(`${job.payText ?? ""}\n${text}`)) return fail("unpaid", "unpaid");
  const kw = t.keywordsAvoid.find((k) => new RegExp(`\\b${escapeRe(k)}\\b`, "i").test(text));
  if (kw) return fail("avoided_keyword", `mentions "${kw}"`);

  const hourly = maxHourly(job.payText ?? "") ?? maxHourly(job.description);
  if (t.minHourly && hourly !== null && hourly < t.minHourly) return fail("pay", `pays up to $${hourly}/hr (min $${t.minHourly})`);

  const modality = job.modality && job.modality !== "unknown" ? job.modality : null;
  if (modality && !t.modalities.includes(modality as "onsite" | "hybrid" | "remote")) return fail("modality", `${modality} only`);
  if (modality !== "remote" && !t.willingToRelocate && job.location && t.locations.length) {
    const loc = normalizeName(job.location);
    const ok = t.locations.some((l) => {
      const city = normalizeName(l.split(",")[0]);
      return city === "remote" ? /remote/.test(loc) : loc.includes(city);
    });
    if (!ok) return fail("location", job.location);
  }

  if ((ctx.employerCounts.get(employerKey) ?? 0) >= ctx.maxPerEmployer) return fail("employer_limit", `already ${ctx.maxPerEmployer} at ${job.employer}`);

  if (job.track === "external" && ctx.postedWithinDays && job.postedAt) {
    const ageDays = (ctx.now.getTime() - Date.parse(job.postedAt)) / 86_400_000;
    if (ageDays > ctx.postedWithinDays) return fail("too_old", `posted ${Math.round(ageDays)} days ago`);
  }

  return { pass: true };
}

const CITIZEN_RE = /(u\.?s\.? citizen(ship)? (is |status )?(required|only)|must be (a )?u\.?s\.? citizens?|only u\.?s\.? citizens|requires? u\.?s\.? citizenship)/i;
const CLEARANCE_RE = /((active|current) (secret|top secret|ts\/sci)|security clearance (is )?required|must (hold|have|obtain) (a |an )?(active )?(security )?clearance)/i;
const NO_SPONSOR_RE = /((unable|not able|cannot|can ?not|will not|won't|do not|does not) (to )?(provide |offer )?(visa )?sponsor|no (visa )?sponsorship|sponsorship (is )?not (available|provided|offered))/i;
const UNPAID_RE = /\b(unpaid|no compensation|volunteer (role|position|opportunity))\b/i;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Highest hourly rate mentioned ("$25-$30/hr", "$28 per hour", "$60,000/year").
export function maxHourly(text: string): number | null {
  let best: number | null = null;
  for (const m of text.matchAll(/\$\s?(\d{2,3}(?:\.\d{1,2})?)(?:\s*(?:-|–|to)\s*\$?\s?(\d{2,3}(?:\.\d{1,2})?))?\s*(?:\/|per|an?)\s*(?:hr|hour)\b/gi)) {
    const v = Number(m[2] ?? m[1]);
    best = best === null ? v : Math.max(best, v);
  }
  for (const m of text.matchAll(/\$\s?(\d{2,3}),?(\d{3})(?:\s*(?:-|–|to)\s*\$?\s?(\d{2,3}),?(\d{3}))?\s*(?:\/|per|a)\s*(?:yr|year|annum)/gi)) {
    const annual = Number(m[3] ? `${m[3]}${m[4]}` : `${m[1]}${m[2]}`);
    const v = Math.round((annual / 2080) * 100) / 100;
    best = best === null ? v : Math.max(best, v);
  }
  return best;
}

// "Spring 2027" matches "Spring 2027 (Jan-Jun)", "January 2027", "Jan - Jun 2027".
export function sameTerm(a: string, b: string): boolean {
  const pa = parseTerm(a);
  const pb = parseTerm(b);
  if (!pa || !pb) return normalizeName(a) === normalizeName(b);
  return pa.season === pb.season && pa.year === pb.year;
}

const MONTH_SEASON: Record<string, string> = {
  jan: "spring", feb: "spring", mar: "spring", apr: "spring",
  may: "summer", jun: "summer",
  jul: "fall", aug: "fall", sep: "fall", oct: "fall", nov: "fall", dec: "fall",
};

export function parseTerm(s: string): { season: string; year: number } | null {
  const t = s.toLowerCase();
  const year = t.match(/\b(20\d\d)\b/);
  if (!year) return null;
  const season = t.match(/\b(spring|summer|fall|autumn|winter)\b/);
  if (season) return { season: season[1] === "autumn" ? "fall" : season[1] === "winter" ? "spring" : season[1], year: Number(year[1]) };
  const month = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/);
  return month ? { season: MONTH_SEASON[month[1]], year: Number(year[1]) } : null;
}
