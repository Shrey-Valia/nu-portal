import type { Settings } from "../config/settings.js";
import type { Db } from "../db/db.js";

export type ApplyTrack = "nuworks" | "external";
export type ApplyMode = "dry-run" | "rehearsal" | "live";

export interface ApplyRequest {
  track: ApplyTrack;
  mode: ApplyMode;
  liveToken: string | null;
}

// Starts the apply CLI. Injectable so tests never spawn a real browser run.
export type SpawnApply = (req: ApplyRequest) => { pid: number | null; log: string | null };

export interface Ctx {
  db: Db;
  settings: Settings;
  token: string;
  port: number;
  spawnApply: SpawnApply;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const REASON_TAGS = [
  "role_mismatch",
  "location",
  "company",
  "too_senior",
  "too_junior",
  "domain",
  "pay",
  "cycle",
  "stack",
  "similar_already",
  "other",
] as const;
