import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

export const execFileAsync = promisify(execFile);

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomBetween([min, max]: readonly [number, number]): number {
  return Math.round(min + Math.random() * Math.max(0, max - min));
}

// Human-paced pause between browser actions.
export function humanDelay(range: readonly [number, number]): Promise<void> {
  return sleep(randomBetween(range));
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function shortHash(text: string): string {
  return sha256(text).slice(0, 16);
}

export async function which(bin: string): Promise<string | null> {
  if (bin.includes("/")) return bin;
  try {
    const { stdout } = await execFileAsync("/usr/bin/which", [bin], {
      env: { ...process.env, PATH: `${process.env.PATH ?? ""}:${process.env.HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin` },
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
