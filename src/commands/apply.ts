import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { getBrain } from "../brain/index.js";
import { loadSettings } from "../config/settings.js";
import { finishRun, startRun } from "../core/events.js";
import { acquireLock } from "../core/lock.js";
import { getKv, openDb, setKv } from "../db/db.js";
import { loadMe } from "../me/load.js";
import { applyExternal, type Mode } from "../pipeline/apply-external.js";
import { guiConfirm } from "../pipeline/confirm.js";

// npm run apply -- --track external [--mode dry-run|rehearsal|live] [--headed] [--max N] [--job ID ...]
//
// Live mode needs one of:
//   - you, at a real terminal, typing SUBMIT (supervised adapters also ask per application)
//   - a one-time token from a click on the dashboard's Live button (with --confirm gui,
//     you also confirm each supervised application in the app)
//   - the launchd schedule (only adapters that already passed 3 supervised submissions)
export default async function apply(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      track: { type: "string", default: "external" },
      mode: { type: "string", default: "dry-run" },
      via: { type: "string", default: "cli" },
      headed: { type: "boolean" },
      max: { type: "string" },
      job: { type: "string", multiple: true },
      confirm: { type: "string" }, // "gui": confirm each supervised submit in the app
    },
  });
  const mode = values.mode as Mode;
  if (!["dry-run", "rehearsal", "live"].includes(mode)) {
    console.error("--mode must be dry-run, rehearsal, or live");
    return 2;
  }
  if (values.track === "nuworks") {
    console.error("NUworks applying is built in Phase 5, after recon maps the apply form. Use the dashboard queue and apply by hand for now.");
    return 2;
  }

  const db = openDb();
  let unattended = false;
  let confirm: ((summary: string, shot: string) => Promise<boolean>) | undefined;
  let headed = values.headed ?? false;

  if (mode === "live") {
    if (values.via === "dashboard") {
      const issued = getKv<{ token: string; track: string; at: string } | null>(db, "dashboard.liveToken", null);
      setKv(db, "dashboard.liveToken", null); // single use, whatever happens next
      const fresh = issued && Date.now() - Date.parse(issued.at) < 10 * 60_000;
      if (!issued || !fresh || issued.track !== values.track || issued.token !== process.env.NUPORTAL_DASHBOARD_LIVE_TOKEN) {
        console.error("Live run refused: missing or expired dashboard token.");
        return 3;
      }
      if (values.confirm === "gui") {
        // You confirm each supervised application in the app, watching the browser.
        confirm = guiConfirm(db);
        headed = true;
      } else unattended = true;
    } else if (values.via === "schedule") {
      if (process.env.NUPORTAL_LAUNCHD !== "1") {
        console.error("Live run refused: --via schedule only works from the launchd agent.");
        return 3;
      }
      unattended = true;
    } else {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.error("Live run refused: run this yourself in a terminal (it asks you to type SUBMIT).");
        return 3;
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const typed = await rl.question("This sends REAL applications. Type SUBMIT to continue: ");
      if (typed.trim() !== "SUBMIT") {
        rl.close();
        console.log("Cancelled.");
        return 0;
      }
      headed = true; // watch it work
      confirm = async (summary, shot) => {
        const a = await rl.question(`\n${summary}\nScreenshot: ${shot}\nSubmit this application? [y/N] `);
        return /^y(es)?$/i.test(a.trim());
      };
      process.once("exit", () => rl.close());
    }
  }

  const release = acquireLock("apply");
  const runId = startRun(db, "apply-external", { mode, via: values.via });
  try {
    const outcomes = await applyExternal(db, getBrain(), loadMe(), loadSettings(), {
      mode,
      unattended,
      headed,
      confirm,
      max: values.max ? Number(values.max) : undefined,
      jobIds: values.job,
      runId,
    });
    for (const o of outcomes) console.log(`${o.result.padEnd(15)} ${o.jobId}  ${o.detail}`);
    if (!outcomes.length) console.log("Nothing approved to apply to.");
    finishRun(db, runId, "ok", { outcomes });
    return 0;
  } catch (err) {
    finishRun(db, runId, "failed", { error: (err as Error).message });
    throw err;
  } finally {
    release();
  }
}
