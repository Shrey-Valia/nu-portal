import { html, type SafeHtml } from "../server/html.js";
import type { SessionInfo } from "./types.js";

// Shared labels and pills for the saved report and the dashboard.

export type Tone = "ok" | "warn" | "bad" | "info" | "muted" | "accent";

const STATUS_TONE: Record<string, Tone> = {
  queued: "accent",
  approved: "info",
  submitting: "info",
  submitted: "ok",
  applied_manual: "ok",
  manual_todo: "warn",
  needs_manual: "warn",
  submit_unknown: "bad",
  failed: "bad",
  halted: "bad",
  skipped: "muted",
  deferred: "muted",
  expired: "muted",
  filtered_out: "muted",
  below_bar: "muted",
  discovered: "muted",
  pending_score: "muted",
  needs_login: "bad",
  captcha: "warn",
  interview: "ok",
  offer: "ok",
  rejected: "muted",
  withdrawn: "muted",
  viewed: "info",
  open: "accent",
  accepted: "ok",
  "dry-run": "muted",
  rehearsal: "info",
  live: "warn",
  running: "info",
  ok: "ok",
};

export function label(value: string | null | undefined): string {
  return (value ?? "").replaceAll("_", " ");
}

export function pill(value: string | null | undefined, text?: string): SafeHtml {
  const tone = STATUS_TONE[value ?? ""] ?? "muted";
  return html`<span class="pill pill-${tone}">${text ?? label(value)}</span>`;
}

export function trackPill(track: string | null | undefined): SafeHtml {
  if (!track) return html``;
  return html`<span class="pill pill-${track === "nuworks" ? "accent" : "info"}">${track === "nuworks" ? "NUworks" : "External"}</span>`;
}

export function scoreTone(score: number | null | undefined): Tone {
  if (score === null || score === undefined) return "muted";
  if (score >= 80) return "ok";
  if (score >= 60) return "info";
  return "warn";
}

export function scoreBadge(score: number | null | undefined): SafeHtml {
  return html`<span class="score score-${scoreTone(score)}" title="Fit score">${score ?? "–"}</span>`;
}

export function sessionView(session: SessionInfo | null): { tone: Tone; text: string } {
  switch (session?.status) {
    case "ok":
      return { tone: "ok", text: "Signed in" };
    case "sso_silent_ok":
      return { tone: "ok", text: "Signed in (SSO)" };
    case "needs_login":
      return { tone: "bad", text: "Sign-in needed" };
    case "error":
      return { tone: "warn", text: "Check failed" };
    default:
      return { tone: "muted", text: "Not checked yet" };
  }
}

export const NEEDS_YOU_LABEL: Record<string, string> = {
  submit_unknown: "Unconfirmed submit",
  needs_manual: "Needs manual apply",
  manual_todo: "Apply by hand",
  needs_login: "Sign in to NUworks",
  captcha: "Captcha",
};

export function daysLeftText(days: number): string {
  if (days < 0) return "passed";
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

export function usd(value: number): string {
  return `$${value.toFixed(value < 1 ? 3 : 2)}`;
}
