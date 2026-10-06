import { loadSettings } from "../config/settings.js";
import { addBrainUsage } from "../core/events.js";
import { openDb } from "../db/db.js";
import { ClaudeCliBrain } from "./claude-cli.js";
import type { Brain } from "./types.js";

let brain: Brain | undefined;

export function getBrain(): Brain {
  // Count every call against its run so the report shows AI usage.
  brain ??= new ClaudeCliBrain(loadSettings().brain, (runId, cost) => addBrainUsage(openDb(), runId, cost));
  return brain;
}

// Tests swap in a FakeBrain.
export function setBrain(b: Brain): void {
  brain = b;
}

export * from "./types.js";
