import type { Posting } from "./adapter.js";
import type { JobDetail } from "./api-schemas.js";

// Turns a NUworks job detail into NU Portal's Posting. Pure, so it's tested
// against synthetic fixtures without touching NUworks.

const lbl = (xs: { _label?: string | null }[] | null | undefined) => (xs ?? []).map((x) => x._label ?? "").filter(Boolean);
const lower = (s: string) => s.toLowerCase();

export function modalityOf(d: JobDetail): Posting["modality"] {
  const w = lower(lbl(d.workplace_type).join(" "));
  if (/remote/.test(w) && !/on-?site|hybrid/.test(w)) return "remote";
  if (/hybrid/.test(w)) return "hybrid";
  if (/on-?site|in[- ]person/.test(w)) return "onsite";
  return "unknown";
}

export function payTextOf(d: JobDetail): string | null {
  const from = d.compensation_from ? Number(d.compensation_from) : null;
  const to = d.compensation_to ? Number(d.compensation_to) : null;
  if (!from && !to) return null;
  const freq = d.compensation_frequency?._label ?? "";
  const range = from && to && from !== to ? `$${from}-$${to}` : `$${from ?? to}`;
  return `${range}${freq ? (/hour/i.test(freq) ? "/hr" : ` ${freq}`) : ""}`;
}

// "College of Engineering/Computer Engineering" -> "Computer Engineering"
const majorName = (s: string) => s.split("/").pop()!.trim();

export function coverLetterOf(d: JobDetail): Posting["coverLetter"] {
  const req = lbl(d.documents_required).map(lower);
  const extra = lbl(d.additional_documents).map(lower);
  if (req.some((x) => x.includes("cover"))) return "required";
  if (extra.some((x) => x.includes("cover"))) return "optional";
  return d.documents_required || d.additional_documents ? "not_accepted" : "unknown";
}

export function toPosting(d: JobDetail): Posting {
  const modes = lower(d.resume_mode ?? "");
  const external = !modes.includes("online") && (modes.includes("other") || !!d.student_link);
  const screened = String(d.screen_flag ?? "0") === "1";
  const gpa = Number(d.screen_gpa ?? 0);
  return {
    id: d.job_id,
    title: d.job_title.trim(),
    employer: (d.employer_name ?? d.job_emp?.name ?? "Unknown employer").trim(),
    location: d.job_location ?? null,
    deadlineAt: d.job_dates?.end ?? null, // keeps NUworks' local time so its date matches the listing
    postedAt: d.created ? new Date(d.created.replace(/([+-]\d{2})(\d{2})$/, "$1:$2")).toISOString() : null,
    description: d.job_desc ?? "",
    modality: modalityOf(d),
    term: d.el_work_term?.title ?? null,
    payText: payTextOf(d),
    qualifications: {
      majors: lbl(d.targeted_academic_majors).map(majorName),
      minGpa: screened && gpa > 0 ? gpa : undefined,
      nuworksQualified: d.is_qualified ?? undefined,
    },
    applyMethod: external ? "external" : "nuworks",
    externalUrl: d.student_link || null,
    coverLetter: coverLetterOf(d),
    requiredDocs: ["resume", ...lbl(d.documents_required).map((x) => lower(x).replace(/\s+/g, "_"))],
    raw: { term_id: d.el_work_term?.term_id ?? null, start: d.start_date_nu ?? null, end: d.desired_end_date ?? null, applied: d.applied ?? false, expired: d.expired ?? false },
  };
}
