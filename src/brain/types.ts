import type { z } from "zod";

export type Tier = "score" | "write";

export interface StructuredRequest<T> {
  purpose: string; // short label for logs, e.g. "score:nuworks:123"
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  tier: Tier;
  timeoutMs?: number;
  runId?: number | null;
}

export interface BrainMeta {
  model: string;
  costUsd: number;
  durationMs: number;
  attempts: number;
}

export interface Brain {
  structured<T>(req: StructuredRequest<T>): Promise<{ data: T; meta: BrainMeta }>;
  health(): Promise<{ ok: boolean; detail: string }>;
}

// Not logged in, hit plan limits, or the CLI is missing. Callers stop AI steps
// for the rest of the run and say so in the report.
export class BrainUnavailableError extends Error {}

// The model answered but never produced valid output after retrying.
export class BrainOutputError extends Error {}
