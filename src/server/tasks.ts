import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DATA_DIR, ROOT } from "../config/paths.js";
import type { Settings } from "../config/settings.js";
import { HttpError } from "./context.js";

// Buttons in the app run fixed CLI commands. Only the kinds below exist, and
// user input only ever becomes validated argv values (never a shell string).

export type TaskKind =
  | "daily"
  | "session-check"
  | "login"
  | "doctor"
  | "doctor-brain"
  | "profile-build"
  | "sources-pull"
  | "apply-dry"
  | "apply-live"
  | "letter-sample"
  | "schedule-install"
  | "schedule-uninstall"
  | "report";

export interface TaskInput {
  repo?: string;
  watch?: boolean;
  posting?: string;
  employer?: string;
  title?: string;
  question?: string;
  liveToken?: string;
}

interface Spec {
  label: string;
  args(input: TaskInput, settings: Settings): string[];
}

const LOGS = () => path.join(DATA_DIR, "logs");

function str(v: unknown, name: string, max: number): string {
  if (typeof v !== "string" || !v.trim()) throw new HttpError(400, `"${name}" is required`);
  if (v.length > max) throw new HttpError(400, `"${name}" is too long`);
  return v.trim();
}

const SPECS: Record<TaskKind, Spec> = {
  daily: { label: "Daily run", args: () => ["daily"] },
  "session-check": { label: "Check NUworks sign-in", args: () => ["session:check"] },
  login: { label: "Sign in to NUworks", args: () => ["login"] },
  doctor: { label: "Health check", args: () => ["doctor"] },
  "doctor-brain": { label: "Health check + Claude test", args: () => ["doctor", "--brain"] },
  "profile-build": { label: "Build profile from documents", args: () => ["profile:build"] },
  "sources-pull": {
    label: "Pull job list",
    args: (i, s) => {
      const repo = str(i.repo, "repo", 200);
      if (!s.external.repos.includes(repo)) throw new HttpError(400, "Add the repo in Settings first");
      return ["sources:pull", repo];
    },
  },
  "apply-dry": { label: "Practice run (nothing sent)", args: (i) => ["apply", "--track", "external", "--mode", "dry-run", ...(i.watch ? ["--headed"] : [])] },
  "apply-live": { label: "Apply for real (you confirm each)", args: () => ["apply", "--track", "external", "--mode", "live", "--via", "dashboard", "--confirm", "gui"] },
  "letter-sample": {
    label: "Sample letter",
    args: (i) => {
      const posting = str(i.posting, "posting", 30_000);
      const employer = str(i.employer, "employer", 200);
      const title = str(i.title, "title", 200);
      const dir = path.join(DATA_DIR, "tmp");
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `posting-${Date.now()}-${randomBytes(4).toString("hex")}.txt`);
      writeFileSync(file, posting);
      const q = typeof i.question === "string" && i.question.trim() ? ["--question", str(i.question, "question", 1000)] : [];
      return ["letter:sample", "--file", file, "--employer", employer, "--title", title, ...q];
    },
  },
  "schedule-install": { label: "Turn on the daily schedule", args: () => ["schedule", "install"] },
  "schedule-uninstall": { label: "Turn off the daily schedule", args: () => ["schedule", "uninstall"] },
  report: { label: "Rebuild today's report", args: () => ["report"] },
};

export const TASK_KINDS = Object.keys(SPECS) as TaskKind[];

export interface Task {
  id: string;
  kind: TaskKind;
  label: string;
  status: "running" | "ok" | "failed";
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  pid: number | null;
  log: string;
}

export type Spawner = (args: string[], logFile: string, env: NodeJS.ProcessEnv) => ChildProcess;

// Detached with output to a log file, so a dashboard restart doesn't kill a run.
export const spawnCli: Spawner = (args, logFile, env) => {
  const fd = openSync(logFile, "a");
  try {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", path.join(ROOT, "src", "cli.ts"), ...args], {
      cwd: ROOT,
      detached: true,
      stdio: ["ignore", fd, fd],
      env,
    });
    child.unref();
    return child;
  } finally {
    closeSync(fd);
  }
};

export class TaskRunner {
  private tasks = new Map<string, Task>();

  constructor(
    private readonly settings: () => Settings,
    private readonly spawner: Spawner = spawnCli,
  ) {}

  start(kind: string, input: TaskInput = {}): Task {
    if (!Object.hasOwn(SPECS, kind)) throw new HttpError(400, "Unknown task");
    const k = kind as TaskKind;
    const busy = [...this.tasks.values()].find((t) => t.kind === k && t.status === "running");
    if (busy) throw new HttpError(409, `${SPECS[k].label} is already running`);
    const args = SPECS[k].args(input, this.settings());
    mkdirSync(LOGS(), { recursive: true });
    const id = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    const log = path.join(LOGS(), `task-${k}-${id}.log`);
    const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: "0" };
    delete env.NUPORTAL_DASHBOARD_LIVE_TOKEN;
    if (k === "apply-live") {
      if (!input.liveToken) throw new HttpError(400, "Live runs need a token");
      env.NUPORTAL_DASHBOARD_LIVE_TOKEN = input.liveToken;
    }
    const child = this.spawner(args, log, env);
    const task: Task = { id, kind: k, label: SPECS[k].label, status: "running", startedAt: new Date().toISOString(), endedAt: null, exitCode: null, pid: child.pid ?? null, log };
    child.on("exit", (code) => {
      task.status = code === 0 ? "ok" : "failed";
      task.exitCode = code;
      task.endedAt = new Date().toISOString();
    });
    child.on("error", (err) => {
      task.status = "failed";
      task.endedAt = new Date().toISOString();
      writeFileSync(log, `\nCould not start: ${err.message}\n`, { flag: "a" });
    });
    this.tasks.set(id, task);
    this.prune();
    return task;
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  list(): Task[] {
    return [...this.tasks.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  running(kind: TaskKind): Task | undefined {
    return this.list().find((t) => t.kind === kind && t.status === "running");
  }

  // The last ~40 KB of output, for the live log view.
  output(task: Task): string {
    try {
      const size = statSync(task.log).size;
      const text = readFileSync(task.log, "utf8");
      return size > 40_000 ? `…\n${text.slice(-40_000)}` : text;
    } catch {
      return "";
    }
  }

  private prune(): void {
    const done = this.list().filter((t) => t.status !== "running");
    for (const t of done.slice(30)) this.tasks.delete(t.id);
  }
}
