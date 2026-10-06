import { loadSettings } from "../config/settings.js";
import { ClaudeCliBrain } from "./claude-cli.js";
import type { Brain } from "./types.js";

let brain: Brain | undefined;

export function getBrain(): Brain {
  brain ??= new ClaudeCliBrain(loadSettings().brain);
  return brain;
}

// Tests swap in a FakeBrain.
export function setBrain(b: Brain): void {
  brain = b;
}

export * from "./types.js";
