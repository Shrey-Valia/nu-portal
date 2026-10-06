// Same job, different listing: re-posts, multi-location copies, and the same
// role appearing on NUworks and in a job-list repo.

const COMPANY_NOISE = /\b(inc|llc|ltd|corp|corporation|co|company|the|group|holdings)\b/g;
const TERM_NOISE = /\b(co ?op|intern(ship)?|spring|summer|fall|winter|20\d\d|jan(uary)?|june?|july|dec(ember)?|6 month)\b/g;

function base(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ");
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

export function normalizeName(s: string): string {
  return squash(base(s).replace(COMPANY_NOISE, " "));
}

export function normalizeTitle(s: string): string {
  return squash(base(s).replace(TERM_NOISE, " "));
}

export function normalizeLocation(s: string | null | undefined): string {
  if (!s) return "";
  const first = s.split(/[;|/]|\bor\b/)[0];
  return normalizeName(first.replace(/,\s*(usa|us|united states)$/i, ""));
}

export function fingerprint(employer: string, title: string, location?: string | null): string {
  return [normalizeName(employer), normalizeTitle(title), normalizeLocation(location)].join("|");
}

// Same employer + same role, ignoring location.
export function roleKey(employer: string, title: string): string {
  return `${normalizeName(employer)}|${normalizeTitle(title)}`;
}
