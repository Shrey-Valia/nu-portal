import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import { LOCKS_DIR } from "../config/paths.js";

// Simple PID lock files. Chrome allows one process per profile, and only one
// pipeline run should touch NUworks at a time.

export class LockBusyError extends Error {
  constructor(
    readonly lockName: string,
    readonly holderPid: number,
  ) {
    super(`"${lockName}" is busy (held by process ${holderPid}). Wait for it to finish.`);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function lockPath(name: string): string {
  return path.join(LOCKS_DIR, `${name}.lock`);
}

export function acquireLock(name: string): () => void {
  mkdirSync(LOCKS_DIR, { recursive: true });
  const file = lockPath(name);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        rmSync(file, { force: true });
      };
      process.once("exit", release);
      return release;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = Number.parseInt(readFileSync(file, "utf8"), 10);
      if (Number.isFinite(holder) && alive(holder)) throw new LockBusyError(name, holder);
      rmSync(file, { force: true }); // stale lock from a crashed process
    }
  }
  throw new Error(`Could not acquire lock ${name}`);
}

export function lockHolder(name: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(lockPath(name), "utf8"), 10);
    return Number.isFinite(pid) && alive(pid) ? pid : null;
  } catch {
    return null;
  }
}
