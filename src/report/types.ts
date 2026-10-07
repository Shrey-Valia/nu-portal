import type { HaltInfo } from "../core/halt.js";

export type { HaltInfo };

export type Track = "nuworks" | "external";

export interface SessionInfo {
  status: string; // ok | sso_silent_ok | needs_login | error
  detail?: string;
  checkedAt?: string;
}

export interface DailySummary {
  cycle: { id: number; label: string } | null;
  capUsed: number; // max(latest snapshot, applications we know about)
  capSnapshot: { count: number; takenAt: string } | null;
  capFromApplications: number;
  cap: number;
  reserve: number;
  weekStart: string; // Monday, YYYY-MM-DD
  weekSubmitted: number; // NUworks only
  weeklyLimit: number;
  appliedToday: { nuworks: number; external: number; total: number };
  queueSize: number;
  needsYouCount: number;
  session: SessionInfo | null;
  halt: HaltInfo | null;
}

export interface AppliedRow {
  applicationId: number;
  jobId: string;
  company: string;
  title: string;
  location: string | null;
  track: Track;
  ats: string | null;
  via: string;
  result: string;
  score: number | null;
  why: string | null;
  letterId: number | null;
  answerIds: number[];
  applyUrl: string | null;
  screenshots: string[];
  submittedAt: string | null;
}

export interface QueueRow {
  jobId: string;
  title: string;
  employer: string;
  location: string | null;
  modality: string | null;
  term: string | null;
  payText: string | null;
  deadlineAt: string | null;
  source: string;
  track: Track;
  applyUrl: string | null;
  score: number | null;
  why: string | null;
  gaps: string[];
  redFlags: string[];
  suspectedInjection: boolean;
  coverLetter: "required" | "optional" | "not_accepted" | "unknown";
}

export type NeedsYouKind = "submit_unknown" | "needs_manual" | "manual_todo" | "needs_login" | "captcha";

export interface NeedsYouItem {
  kind: NeedsYouKind;
  jobId: string | null;
  title: string | null;
  employer: string | null;
  track: Track | null;
  applyUrl: string | null;
  message: string;
  at: string | null;
}

export interface FilteredCount {
  status: "filtered_out" | "below_bar" | "skipped";
  reason: string | null;
  count: number;
}

export interface StatusChange {
  applicationId: number;
  jobId: string;
  company: string;
  title: string;
  track: Track;
  remoteStatus: string | null;
  at: string;
}

export interface DeadlineRow {
  jobId: string;
  title: string;
  employer: string;
  status: string;
  track: Track;
  deadlineAt: string;
  daysLeft: number;
}

export interface Pacing {
  weeklyLimit: number;
  weekSubmitted: number;
  weeklyRemaining: number;
  cap: number;
  used: number;
  reserve: number;
  cycleRemaining: number; // cap - used - reserve, floored at 0
  ready: number; // scored above the bar, waiting for a queue slot
}

export interface BrainUsage {
  runs: number;
  calls: number;
  costUsd: number;
}

export interface ProblemEvent {
  id: number;
  ts: string;
  level: "warn" | "error";
  kind: string;
  message: string;
  jobId: string | null;
}

export interface DailyReport {
  version: 1;
  day: string;
  timezone: string;
  generatedAt: string;
  range: { start: string; end: string };
  week: { start: string; end: string };
  summary: DailySummary;
  appliedToday: AppliedRow[];
  queue: QueueRow[];
  needsYou: NeedsYouItem[];
  filteredCounts: FilteredCount[];
  statusChanges: StatusChange[];
  deadlines: DeadlineRow[];
  pacing: Pacing;
  brain: BrainUsage;
  problems: ProblemEvent[];
}
