import { loadSettings } from "../config/settings.js";
import { openDb } from "../db/db.js";
import { dayIn, isDay } from "../core/time.js";
import { writeDailyReport } from "./write.js";

// `nup report [--day YYYY-MM-DD]` writes data/reports/<day>.json and .html.
export default async function report(args: string[]): Promise<number> {
  const settings = loadSettings();
  const i = args.indexOf("--day");
  const day = i >= 0 ? args[i + 1] : dayIn(settings.timezone);
  if (!isDay(day)) {
    console.error(`Expected --day YYYY-MM-DD, got "${day ?? ""}"`);
    return 2;
  }
  const { html, json, report } = writeDailyReport(openDb(), day, settings);
  const s = report.summary;
  console.log(`Report for ${day}`);
  console.log(`  applied today: ${s.appliedToday.total} (${s.appliedToday.nuworks} NUworks, ${s.appliedToday.external} external)`);
  console.log(`  NUworks cap: ${s.capUsed}/${s.cap}  week: ${s.weekSubmitted}/${s.weeklyLimit}  queue: ${s.queueSize}  needs you: ${s.needsYouCount}`);
  if (s.halt) console.log(`  HALTED: offer accepted from ${s.halt.employer} on ${s.halt.date}`);
  console.log(`  ${html}\n  ${json}`);
  return 0;
}
