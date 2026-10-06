// Job lifecycle. Every status change goes through assertTransition(), and
// every transition is written to the events table (see transition() in events.ts).

export const JOB_STATES = [
  "discovered", // seen in a search or job list, not yet evaluated
  "filtered_out", // failed an eligibility or preference rule
  "pending_score", // passed filters, waiting for the AI
  "below_bar", // scored under the threshold
  "ready", // scored above the threshold, waiting for room in the daily queue
  "queued", // waiting for your approve/skip
  "manual_todo", // a match, but it has to be applied to by hand (Workday, unknown form, ...)
  "approved", // you (or auto mode) said yes; waiting for an apply run
  "skipped",
  "deferred",
  "expired", // deadline passed or sat in the queue too long
  "halted", // stopped by the offer-accepted kill switch
  "submitting",
  "submitted",
  "needs_manual", // apply run hit something it could not handle safely
  "failed",
  "submit_unknown", // clicked submit but could not confirm; reconciled before anything else
  "applied_manual", // you applied yourself
] as const;

export type JobState = (typeof JOB_STATES)[number];

const TRANSITIONS: Record<JobState, readonly JobState[]> = {
  discovered: ["filtered_out", "pending_score", "expired"],
  filtered_out: ["discovered"],
  pending_score: ["below_bar", "ready", "queued", "manual_todo", "approved", "filtered_out", "expired"],
  below_bar: ["pending_score", "queued", "expired"],
  ready: ["queued", "approved", "manual_todo", "pending_score", "filtered_out", "expired", "halted"],
  queued: ["approved", "skipped", "deferred", "expired", "halted", "pending_score", "manual_todo", "applied_manual"],
  manual_todo: ["applied_manual", "skipped", "expired", "halted"],
  approved: ["submitting", "needs_manual", "queued", "halted", "expired", "pending_score"],
  skipped: ["queued"],
  deferred: ["queued", "expired", "halted"],
  expired: [],
  halted: ["queued"],
  submitting: ["submitted", "needs_manual", "failed", "submit_unknown"],
  submitted: [],
  needs_manual: ["applied_manual", "skipped", "approved"],
  failed: ["approved", "needs_manual", "skipped"],
  submit_unknown: ["submitted", "approved", "needs_manual"],
  applied_manual: [],
};

export function canTransition(from: JobState, to: JobState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: JobState, to: JobState): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal job transition: ${from} -> ${to}`);
  }
}

export function isJobState(value: string): value is JobState {
  return (JOB_STATES as readonly string[]).includes(value);
}

// States the kill switch moves to "halted".
export const HALTABLE: readonly JobState[] = ["ready", "queued", "approved", "deferred", "manual_todo"];
