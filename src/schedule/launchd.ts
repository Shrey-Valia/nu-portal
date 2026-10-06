import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA_DIR, ROOT } from "../config/paths.js";
import { execFileAsync, which } from "../core/util.js";

const AGENTS_DIR = path.join(os.homedir(), "Library", "LaunchAgents");
export const LOGS_DIR = path.join(DATA_DIR, "logs");

export interface AgentSpec {
  label: string; // e.g. com.nuportal.daily
  args: string[]; // arguments after `src/cli.ts`
  runAtLoad?: boolean;
  keepAlive?: boolean;
  // launchd fires a missed calendar slot once the Mac wakes up.
  calendar?: { Hour: number; Minute: number; Weekday?: number }[];
}

const xml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

// Absolute paths everywhere: launchd starts jobs with a bare PATH and no shell profile.
export async function buildPlist(spec: AgentSpec): Promise<string> {
  const claude = (await which("claude")) ?? "";
  const pathDirs = [path.dirname(process.execPath), claude ? path.dirname(claude) : "", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
    .filter(Boolean)
    .filter((d, i, all) => all.indexOf(d) === i);
  const program = [process.execPath, "--disable-warning=ExperimentalWarning", "--import", "tsx", path.join(ROOT, "src", "cli.ts"), ...spec.args];
  const env: Record<string, string> = {
    PATH: pathDirs.join(":"),
    HOME: os.homedir(),
    DISABLE_AUTOUPDATER: "1",
    NUPORTAL_LAUNCHD: "1",
  };
  const log = path.join(LOGS_DIR, `${spec.label}.log`);
  const calendar = spec.calendar?.length
    ? `<key>StartCalendarInterval</key><array>${spec.calendar
        .map((c) => `<dict>${Object.entries(c).map(([k, v]) => `<key>${k}</key><integer>${v}</integer>`).join("")}</dict>`)
        .join("")}</array>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(spec.label)}</string>
<key>ProgramArguments</key><array>${program.map((a) => `<string>${xml(a)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(ROOT)}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k, v]) => `<key>${k}</key><string>${xml(v)}</string>`).join("")}</dict>
<key>StandardOutPath</key><string>${xml(log)}</string>
<key>StandardErrorPath</key><string>${xml(log)}</string>
<key>RunAtLoad</key><${spec.runAtLoad ? "true" : "false"}/>
${spec.keepAlive ? "<key>KeepAlive</key><true/>" : ""}
${calendar}
</dict></plist>
`;
}

export function plistPath(label: string): string {
  return path.join(AGENTS_DIR, `${label}.plist`);
}

const domain = () => `gui/${process.getuid?.() ?? 501}`;

export async function installAgent(spec: AgentSpec): Promise<string> {
  mkdirSync(AGENTS_DIR, { recursive: true });
  mkdirSync(LOGS_DIR, { recursive: true });
  const file = plistPath(spec.label);
  await uninstallAgent(spec.label);
  writeFileSync(file, await buildPlist(spec));
  await execFileAsync("/bin/launchctl", ["bootstrap", domain(), file]);
  return file;
}

export async function uninstallAgent(label: string): Promise<void> {
  await execFileAsync("/bin/launchctl", ["bootout", `${domain()}/${label}`]).catch(() => {});
  rmSync(plistPath(label), { force: true });
}
