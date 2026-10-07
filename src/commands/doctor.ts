import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { DATA_DIR, ME_DIR, ROOT } from "../config/paths.js";
import { loadSettings } from "../config/settings.js";
import { execFileAsync, sleep, which } from "../core/util.js";
import { getKv, openDb } from "../db/db.js";
import { getBrain } from "../brain/index.js";
import { findHumanizerSkill } from "../brain/humanizer.js";
import { loadMe, MeMissingError } from "../me/load.js";
import { checkSession } from "../nuworks/session.js";
import { installAgent, LOGS_DIR, uninstallAgent } from "../schedule/launchd.js";

type Status = "ok" | "warn" | "fail";
interface Check {
  name: string;
  status: Status;
  detail: string;
}

const ICON: Record<Status, string> = { ok: "✔", warn: "!", fail: "✘" };

export default async function doctor(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      brain: { type: "boolean" },
      session: { type: "boolean" },
      launchd: { type: "boolean" },
      json: { type: "boolean" },
      out: { type: "string" },
    },
  });

  if (values.launchd) return runUnderLaunchd();

  const checks: Check[] = [];
  const add = (name: string, status: Status, detail: string) => checks.push({ name, status, detail });

  const [major, minor] = process.versions.node.split(".").map(Number);
  add("Node.js", major > 22 || (major === 22 && minor >= 13) ? "ok" : "fail", `v${process.versions.node} (need 22.13+)`);
  add("Google Chrome", existsSync("/Applications/Google Chrome.app") ? "ok" : "fail", "/Applications/Google Chrome.app");

  try {
    const s = loadSettings();
    add("Settings", "ok", existsSync(path.join(ROOT, "config", "settings.yaml")) ? `config/settings.yaml (cycle ${s.cycle.label})` : `defaults (cycle ${s.cycle.label}); copy config/settings.example.yaml to customize`);
  } catch (err) {
    add("Settings", "fail", (err as Error).message);
  }

  try {
    const db = openDb();
    const v = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    add("Database", "ok", `data/nuportal.db (schema v${v})`);
    const session = getKv<{ status: string; checkedAt: string } | null>(db, "session", null);
    if (!values.session) {
      add("NUworks session (last check)", session ? (session.status.endsWith("ok") ? "ok" : "warn") : "warn", session ? `${session.status} at ${session.checkedAt}` : "never checked; app: Setup → Sign in to NUworks (or npm run login)");
    }
  } catch (err) {
    add("Database", "fail", (err as Error).message);
  }

  try {
    const me = loadMe();
    add("Profile (me/profile.yaml)", "ok", `${me.profile.identity.preferredName ?? me.profile.identity.name}: ${me.profile.experiences.length} experiences, ${me.profile.skills.length} skills, ${me.stories.length} stories`);
    add("Resume (me/resume.pdf)", me.files.resume ? "ok" : "warn", me.files.resume ? "found" : "missing");
    const li = me.profile.identity.links.linkedin;
    add("LinkedIn link", li ? "ok" : "warn", li ? li : "not set; app: Setup → LinkedIn profile link");
  } catch (err) {
    add("Profile (me/profile.yaml)", err instanceof MeMissingError ? "warn" : "fail", (err as Error).message.split("\n")[0]);
  }
  add("Private details (me/private.yaml)", existsSync(path.join(ME_DIR, "private.yaml")) ? "ok" : "warn", existsSync(path.join(ME_DIR, "private.yaml")) ? "found (contents never checked or shown)" : "missing; app: Setup → Private details");

  const claude = await which(loadSettings().brain.claudeBin);
  if (!claude) {
    add("Claude CLI", "fail", "claude not found on PATH");
  } else {
    try {
      const { stdout } = await execFileAsync(claude, ["auth", "status"], { timeout: 20_000 });
      const status = JSON.parse(stdout) as { loggedIn?: boolean; authMethod?: string };
      add("Claude CLI", status.loggedIn ? "ok" : "fail", status.loggedIn ? `${claude} (${status.authMethod})` : "not signed in; app: Setup → Sign in to Claude (or claude auth login)");
    } catch (err) {
      add("Claude CLI", "fail", (err as Error).message.split("\n")[0]);
    }
  }
  if (values.brain) {
    const h = await getBrain().health();
    add("AI round trip", h.ok ? "ok" : "fail", h.detail);
  }

  const humanizer = findHumanizerSkill();
  add("Humanizer plugin", humanizer ? "ok" : "fail", humanizer ?? "SKILL.md not found; install with: claude plugin install humanizer@humanizer");

  try {
    const { stdout } = await execFileAsync("git", ["config", "core.hooksPath"], { cwd: ROOT });
    add("Git privacy hook", stdout.trim() === ".githooks" ? "ok" : "warn", stdout.trim() === ".githooks" ? ".githooks/pre-commit active" : "run: npm install (sets core.hooksPath)");
  } catch {
    add("Git privacy hook", "warn", "not active; run: npm install");
  }

  if (values.session) {
    const r = await checkSession(openDb());
    add("NUworks session", r.status.endsWith("ok") ? "ok" : "fail", `${r.status}: ${r.detail}`);
  }

  if (values.out) {
    mkdirSync(path.dirname(values.out), { recursive: true });
    writeFileSync(values.out, JSON.stringify({ at: new Date().toISOString(), launchd: process.env.NUPORTAL_LAUNCHD === "1", checks }, null, 2));
  }
  if (values.json) console.log(JSON.stringify(checks, null, 2));
  else printChecks(checks);
  return checks.some((c) => c.status === "fail") ? 1 : 0;
}

function printChecks(checks: Check[]): void {
  for (const c of checks) console.log(`${ICON[c.status]} ${c.name.padEnd(34)} ${c.detail}`);
}

// Runs doctor once as a launchd job, the same way the daily schedule will,
// to catch PATH, keychain, and macOS folder-privacy problems early.
async function runUnderLaunchd(): Promise<number> {
  const label = "com.nuportal.doctor";
  const out = path.join(DATA_DIR, "doctor-launchd.json");
  rmSync(out, { force: true });
  console.log("Running doctor as a launchd job (up to 3 minutes)…");
  await installAgent({ label, args: ["doctor", "--brain", "--session", "--out", out], runAtLoad: true });
  const deadline = Date.now() + 180_000;
  while (!existsSync(out) && Date.now() < deadline) await sleep(1000);
  await uninstallAgent(label);
  if (!existsSync(out)) {
    const logFile = path.join(LOGS_DIR, `${label}.log`);
    const log = existsSync(logFile) ? readFileSync(logFile, "utf8").slice(-2000) : "(no log)";
    console.log("✘ The launchd job never finished.");
    if (/Operation not permitted|EPERM/.test(log)) {
      console.log(
        "  macOS blocked node from reading ~/Desktop. Fix one of two ways:\n" +
          `  1. System Settings → Privacy & Security → Files and Folders (or Full Disk Access) → allow ${process.execPath}\n` +
          "  2. Move the repo out of Desktop, e.g. to ~/code/nu-portal",
      );
    }
    console.log(`  Log tail:\n${log}`);
    return 1;
  }
  const result = JSON.parse(readFileSync(out, "utf8")) as { checks: Check[] };
  console.log("Results from inside launchd:");
  printChecks(result.checks);
  return result.checks.some((c) => c.status === "fail") ? 1 : 0;
}
