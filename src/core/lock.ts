import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import { LOCKS_DIR } from "../config/paths.js";

// Simple PID lock files. Chrome allows one process per profile, and only one
// pipeline run should touch NUworks at a time.

export class LockBusyError extends Error {
  constructor(
    readonly lockName: string,
    readonly holderPid: number,
    readonly holderPurpose: string | null = null,
  ) {
    super(
      holderPurpose
        ? `${holderPurpose[0].toUpperCase()}${holderPurpose.slice(1)} is using the browser (process ${holderPid}).${/sign-in window/.test(holderPurpose) ? " Finish signing in, close that Chrome window, then try again." : " Wait for it to finish, then try again."}`
        : `"${lockName}" is busy (held by process ${holderPid}). Wait for it to finish.`,
    );
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

// `purpose` (e.g. "the NUworks sign-in window") goes in the lock file so a
// blocked process can say what's in the way.
export function acquireLock(name: string, purpose?: string): () => void {
  mkdirSync(LOCKS_DIR, { recursive: true });
  const file = lockPath(name);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx");
      writeSync(fd, purpose ? `${process.pid}\n${purpose}` : String(process.pid));
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
      const [pidLine, holderPurpose] = readFileSync(file, "utf8").split("\n");
      const holder = Number.parseInt(pidLine, 10);
      if (Number.isFinite(holder) && alive(holder)) throw new LockBusyError(name, holder, holderPurpose?.trim() || null);
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
