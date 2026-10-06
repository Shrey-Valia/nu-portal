import type { AtsKind } from "./types.js";

// Which application system a posting URL belongs to, from its hostname, path and query.

function parse(url: string): URL | null {
  try {
    return new URL(url.trim());
  } catch {
    return null;
  }
}

const hostIs = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

export function detectAts(url: string): AtsKind {
  const u = parse(url);
  if (!u) return "other";
  const host = u.hostname.toLowerCase();
  const q = u.searchParams;

  // boards.greenhouse.io, job-boards.greenhouse.io, job-boards.eu.greenhouse.io, .../embed/job_app?for=..&token=..
  if (hostIs(host, "greenhouse.io")) return "greenhouse";
  if (hostIs(host, "lever.co")) return "lever";
  if (hostIs(host, "ashbyhq.com")) return "ashby";
  if (hostIs(host, "myworkdayjobs.com") || hostIs(host, "myworkdaysite.com") || hostIs(host, "myworkday.com") || host.includes("workday"))
    return "workday";
  if (hostIs(host, "icims.com")) return "icims";
  if (hostIs(host, "taleo.net")) return "taleo";
  if (hostIs(host, "smartrecruiters.com")) return "smartrecruiters";
  if (hostIs(host, "jobvite.com")) return "jobvite";

  // Company career sites that embed an ATS keep its job id in the query string.
  if (q.has("gh_jid")) return "greenhouse";
  if (q.has("ashby_jid")) return "ashby";
  if (q.has("lever-source") || q.has("lever-source[]") || q.has("lever-origin")) return "lever";
  return "other";
}

// The application-form URL for a posting URL, where the ATS puts the form on its own page.
export function applyUrlFor(kind: AtsKind, url: string): string {
  const u = parse(url);
  if (!u) return url;
  const parts = u.pathname.split("/").filter(Boolean);
  if (kind === "lever" && hostIs(u.hostname.toLowerCase(), "lever.co")) {
    // jobs.lever.co/<company>/<posting-id>[/apply]
    if (parts.length === 2) {
      u.pathname = `/${parts[0]}/${parts[1]}/apply`;
      return u.toString();
    }
    return url;
  }
  if (kind === "ashby" && hostIs(u.hostname.toLowerCase(), "ashbyhq.com")) {
    // jobs.ashbyhq.com/<company>/<posting-id>[/application]
    if (parts.length === 2 && /^[0-9a-f-]{8,}$/i.test(parts[1])) {
      u.pathname = `/${parts[0]}/${parts[1]}/application`;
      return u.toString();
    }
    return url;
  }
  // Greenhouse shows the form on the posting page itself (and the legacy boards host redirects to it).
  return url;
}
