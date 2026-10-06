import type { PrivateInfo, Profile } from "../me/schema.js";
import {
  DECLINE_RE,
  isoDate,
  matchLocation,
  matchNumericRange,
  matchOption,
  monthName,
  parseLooseDate,
  pickDecline,
  stateName,
  usDate,
} from "./common.js";
import type { ApplyForm, FieldValue, FillPlan, FormField } from "./types.js";

// Deterministic answers for every field whose role we know. Custom questions, and anything we
// cannot map confidently, go to `unresolved` for the answer bank / AI layer.

const SKIP = Symbol("skip"); // leave an optional field empty on purpose
type Answer = FieldValue | null | typeof SKIP;

const NAME_PARTICLES = new Set(["de", "da", "del", "della", "der", "di", "du", "la", "le", "van", "von", "bin", "al", "dos", "das", "ten", "ter", "st", "st."]);
const SUFFIX = /^(jr|sr|ii|iii|iv|v)\.?$/i;

export function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { first: parts[0] ?? "", last: "" };
  let end = parts.length;
  if (SUFFIX.test(parts[end - 1]) && end > 2) end--; // "John Smith Jr." -> last "Smith Jr."
  let i = end - 1;
  while (i > 1 && NAME_PARTICLES.has(parts[i - 1].toLowerCase())) i--;
  return { first: parts.slice(0, i).join(" "), last: parts.slice(i).join(" ") };
}

function degreeCandidates(degree: string): string[] {
  const d = degree.toLowerCase().replace(/[.\s']/g, "");
  if (/^(bs|bsc|ba|bse|bachelor|bachelors|undergrad)/.test(d) || d.includes("bachelor")) {
    const specific = /^ba$|arts/.test(d) ? ["Bachelor of Arts", "BA", "B.A."] : /^bs|science|engineering/.test(d) ? ["Bachelor of Science", "BS", "B.S."] : [];
    return [degree, ...specific, "Bachelor's Degree", "Bachelor's", "Bachelors", "Bachelor", "Undergraduate"];
  }
  if (/^(ms|msc|ma|meng|master)/.test(d)) return [degree, "Master of Science", "Master's Degree", "Master's", "Masters", "Master"];
  if (/^(phd|doctor)/.test(d)) return [degree, "PhD", "Ph.D.", "Doctorate", "Doctor of Philosophy"];
  if (/^(as|aa|associate)/.test(d)) return [degree, "Associate's Degree", "Associate's", "Associates", "Associate"];
  return [degree];
}

const isChoice = (f: FormField) => f.type === "select" || f.type === "radio" || f.type === "checkbox";
const missing = (f: FormField): Answer => (f.required ? null : SKIP);

// Pick from the field's options when it has them; free text otherwise.
function choose(f: FormField, candidates: (string | null | undefined)[]): Answer {
  const wants = candidates.filter((c): c is string => !!c && !!c.trim());
  if (!wants.length) return missing(f);
  if (isChoice(f) && f.options?.length) {
    const m = matchOption(f.options, wants);
    if (!m) return null;
    return f.type === "checkbox" ? [m] : m;
  }
  if (f.type === "checkbox") return null; // a checkbox without options: nothing sensible to tick
  // Text, or a search-as-you-type dropdown whose options load while typing.
  if (f.maxLength && wants[0].length > f.maxLength) return null;
  return wants[0];
}

function yesNo(f: FormField, yes: boolean): Answer {
  return choose(f, [yes ? "Yes" : "No"]);
}

function eeo(f: FormField, value: string): Answer {
  if (isChoice(f) && f.options?.length) {
    const m = DECLINE_RE.test(value) ? pickDecline(f.options) : matchOption(f.options, value);
    if (!m) return null;
    return f.type === "checkbox" ? [m] : m;
  }
  return choose(f, [value]);
}

interface Ctx {
  profile: Profile;
  priv: PrivateInfo;
  files: { resume: string; coverLetter?: string };
  first: string;
  last: string;
}

function valueFor(f: FormField, c: Ctx): Answer {
  const { profile: p, priv } = c;
  const id = p.identity;
  const edu = p.education;
  const label = f.label.toLowerCase();
  switch (f.role) {
    case "first_name":
      return choose(f, [c.first]);
    case "last_name":
      return c.last ? choose(f, [c.last]) : missing(f);
    case "full_name":
      return choose(f, [id.name]);
    case "preferred_name":
      return choose(f, [id.preferredName ?? c.first]);
    case "email":
      return choose(f, [id.email]);
    case "phone":
      return id.phone ? choose(f, [id.phone]) : missing(f);
    case "location": {
      const city = id.city ?? [priv.address?.city, priv.address?.state].filter(Boolean).join(", ");
      if (!city) return missing(f);
      const cityOnly = /^(current )?city$/.test(label) ? (priv.address?.city ?? city.split(",")[0].trim()) : city;
      if (isChoice(f) && f.options?.length) {
        const m = matchLocation(f.options, cityOnly);
        return m ? (f.type === "checkbox" ? [m] : m) : null;
      }
      return choose(f, [cityOnly]);
    }
    case "resume":
      return f.type === "file" ? { file: c.files.resume } : null;
    case "cover_letter":
      if (f.type === "file" && c.files.coverLetter) return { file: c.files.coverLetter };
      return null; // a written letter (or a missing file) is the writing layer's job
    case "linkedin":
      return id.links.linkedin ? choose(f, [id.links.linkedin]) : missing(f);
    case "github":
      return id.links.github ? choose(f, [id.links.github]) : missing(f);
    case "website": {
      const site = /portfolio/.test(label) ? (id.links.portfolio ?? id.links.website) : (id.links.website ?? id.links.portfolio);
      return site ? choose(f, [site]) : missing(f);
    }
    case "school":
      return choose(f, [edu.school]);
    case "degree":
      return choose(f, degreeCandidates(edu.degree));
    case "discipline":
      if (isChoice(f)) return choose(f, edu.majors);
      return choose(f, [edu.majors.join(", ")]);
    case "grad_date": {
      const d = parseLooseDate(edu.gradDate);
      if (!d) return choose(f, [edu.gradDate]);
      const season = d.m <= 6 ? "Spring" : d.m <= 8 ? "Summer" : "Fall";
      if (/month/.test(label)) return choose(f, isChoice(f) ? [monthName(d.m), String(d.m).padStart(2, "0"), String(d.m)] : [monthName(d.m)]);
      if (/year/.test(label)) return choose(f, [String(d.y)]);
      if (f.type === "date") return isoDate(d);
      if (isChoice(f)) return choose(f, [edu.gradDate, `${monthName(d.m)} ${d.y}`, `${season} ${d.y}`, usDate(d).replace(/^(\d\d)\/\d\d\//, "$1/"), String(d.y)]);
      return choose(f, [edu.gradDate]);
    }
    case "gpa": {
      if (!edu.shareGpa || edu.gpa === undefined) return missing(f);
      const g = edu.gpa;
      const text = Number.isInteger(g * 10) ? g.toFixed(1) : g.toFixed(2);
      if (isChoice(f) && f.options?.length) {
        const m = matchOption(f.options, [text, g.toFixed(2)]) ?? matchNumericRange(f.options, g);
        return m ? (f.type === "checkbox" ? [m] : m) : null;
      }
      return choose(f, [text]);
    }
    case "work_authorization": {
      const yes = /without\b.*sponsor/.test(label) ? p.workAuth.authorizedUS && !p.workAuth.needsSponsorship : p.workAuth.authorizedUS;
      return yesNo(f, yes);
    }
    case "sponsorship":
      return yesNo(f, p.workAuth.needsSponsorship);
    case "start_date":
      return null; // co-op start dates depend on the posting; left to the answer bank / AI layer
    case "eeo_gender":
      return eeo(f, priv.eeo.gender);
    case "eeo_race":
      return eeo(f, priv.eeo.race);
    case "eeo_hispanic":
      return eeo(f, priv.eeo.hispanicLatino);
    case "eeo_veteran":
      return eeo(f, priv.eeo.veteran);
    case "eeo_disability":
      return eeo(f, priv.eeo.disability);
    case "date_of_birth": {
      const d = priv.dateOfBirth ? parseLooseDate(priv.dateOfBirth) : null;
      if (!d) return missing(f);
      return f.type === "date" ? isoDate(d) : choose(f, [usDate(d)]);
    }
    case "address":
      return addressValue(f, c);
    case "custom":
      return null;
  }
}

function addressValue(f: FormField, c: Ctx): Answer {
  const a = c.priv.address;
  const label = f.label.toLowerCase();
  if (/country/.test(label)) {
    const country = a?.country ?? (c.profile.workAuth.authorizedUS || c.profile.identity.phone?.startsWith("+1") ? "United States" : undefined);
    return country ? choose(f, [country, country === "United States" ? "United States of America" : "", country === "United States" ? "USA" : ""]) : missing(f);
  }
  if (!a) return missing(f);
  if (/line ?2|apt|apartment|suite|unit/.test(label)) return SKIP;
  if (/zip|postal|post ?code/.test(label)) return a.zip ? choose(f, [a.zip]) : missing(f);
  if (/state|province|region/.test(label)) return a.state ? choose(f, [a.state, stateName(a.state)]) : missing(f);
  if (/city|town/.test(label)) return a.city ? choose(f, [a.city]) : missing(f);
  if (/street|line ?1/.test(label)) return a.street ? choose(f, [a.street]) : missing(f);
  if (/address/.test(label)) {
    if (!a.street || !a.city) return missing(f);
    const tail = [a.state, a.zip].filter(Boolean).join(" ");
    return choose(f, [[a.street, a.city, tail].filter(Boolean).join(", ")]);
  }
  return null;
}

export function standardFillPlan(
  form: ApplyForm,
  profile: Profile,
  priv: PrivateInfo,
  files: { resume: string; coverLetter?: string },
): { plan: FillPlan; unresolved: FormField[] } {
  const { first, last } = splitName(profile.identity.name);
  const ctx: Ctx = { profile, priv, files, first, last };
  const plan: FillPlan = {};
  const unresolved: FormField[] = [];
  for (const f of form.fields) {
    if (f.role === "custom") {
      unresolved.push(f);
      continue;
    }
    const v = valueFor(f, ctx);
    if (v === SKIP) continue;
    if (v === null) unresolved.push(f);
    else plan[f.key] = v;
  }
  return { plan, unresolved };
}
