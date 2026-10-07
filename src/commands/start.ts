import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { DATA_DIR, ROOT } from "../config/paths.js";
import { loadSettings } from "../config/settings.js";
import { execFileAsync, sleep, which } from "../core/util.js";

// npm start: opens the app in your browser, starting it first if needed.
// The NU Portal.app icon runs this too.
export default async function start(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { "no-open": { type: "boolean" } } });
  const port = loadSettings().server.port;
  const url = `http://127.0.0.1:${port}/`;

  if (!(await isUp(url))) {
    const logs = path.join(DATA_DIR, "logs");
    mkdirSync(logs, { recursive: true });
    const fd = openSync(path.join(logs, "app.log"), "a");
    const claude = await which("claude");
    const PATH = [path.dirname(process.execPath), claude ? path.dirname(claude) : "", "/opt/homebrew/bin", "/usr/local/bin", process.env.PATH ?? "/usr/bin:/bin"]
      .filter(Boolean)
      .join(":");
    try {
      spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", path.join(ROOT, "src", "cli.ts"), "serve"], {
        cwd: ROOT,
        detached: true,
        stdio: ["ignore", fd, fd],
        env: { ...process.env, PATH },
      }).unref();
    } finally {
      closeSync(fd);
    }
    const deadline = Date.now() + 20_000;
    while (!(await isUp(url)) && Date.now() < deadline) await sleep(300);
    if (!(await isUp(url))) {
      console.error(`NU Portal didn't start. See ${path.join(logs, "app.log")}`);
      return 1;
    }
  }
  console.log(`NU Portal is running at ${url}`);
  if (!values["no-open"]) await execFileAsync("/usr/bin/open", [url]);
  return 0;
}

async function isUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}
