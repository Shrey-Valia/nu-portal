import { randomBytes } from "node:crypto";
import { haltInfo } from "../core/halt.js";
import { sleep } from "../core/util.js";
import { type Db, getKv, now, setKv } from "../db/db.js";

// Supervised applying from the app: before each submit the apply process posts
// the summary + screenshot here and waits for your Submit/Skip click on the
// dashboard. No answer in 15 minutes, or the kill switch, means skip.

export interface PendingConfirm {
  id: string;
  summary: string;
  screenshot: string;
  at: string;
}

export interface ConfirmAnswer {
  id: string;
  decision: "submit" | "skip";
}

export function guiConfirm(db: Db, timeoutMs = 15 * 60_000) {
  return async (summary: string, screenshot: string): Promise<boolean> => {
    const id = randomBytes(8).toString("hex");
    setKv(db, "apply.answer", null);
    setKv(db, "apply.pending", { id, summary, screenshot, at: now() } satisfies PendingConfirm);
    const deadline = Date.now() + timeoutMs;
    try {
      while (Date.now() < deadline) {
        if (haltInfo(db)) return false;
        const answer = getKv<ConfirmAnswer | null>(db, "apply.answer", null);
        if (answer?.id === id) return answer.decision === "submit";
        await sleep(800);
      }
      return false;
    } finally {
      setKv(db, "apply.pending", null);
      setKv(db, "apply.answer", null);
    }
  };
}
