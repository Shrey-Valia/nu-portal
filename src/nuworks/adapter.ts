import type { Qualifications } from "../core/filters.js";

// Everything NU Portal needs from NUworks. The live implementation is written
// after recon maps the real Symplicity pages; the fixture implementation lets
// the rest of the pipeline run and be tested before that.

export interface PostingSummary {
  id: string; // NUworks job id
  title: string;
  employer: string;
  location: string | null;
  deadlineAt: string | null;
  postedAt: string | null;
}

export interface Posting extends PostingSummary {
  description: string; // HTML or text; sanitized before any AI sees it
  modality: "onsite" | "hybrid" | "remote" | "unknown";
  term: string | null; // co-op cycle as NUworks labels it
  payText: string | null;
  qualifications: Qualifications;
  applyMethod: "nuworks" | "external";
  externalUrl: string | null;
  coverLetter: "required" | "optional" | "not_accepted" | "unknown";
  requiredDocs: string[]; // e.g. ["resume", "cover_letter", "transcript"]
  raw: unknown;
}

export interface ApplicationRow {
  jobId: string;
  title: string;
  employer: string;
  appliedAt: string | null;
  status: string; // as NUworks shows it
}

export interface ApplicationsSnapshot {
  rows: ApplicationRow[];
  capCount: number | null; // "N of 100 applications used", if NUworks shows it
  capShown: number | null;
}

export interface NuworksAdapter {
  readonly kind: "live" | "fixture";
  search(): Promise<PostingSummary[]>;
  detail(id: string): Promise<Posting>;
  applications(): Promise<ApplicationsSnapshot>;
  resumeStatus(): Promise<{ approved: boolean; name: string | null }>;
  close(): Promise<void>;
}

export class AdapterNotReadyError extends Error {}
