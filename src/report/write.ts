import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { REPORTS_DIR } from "../config/paths.js";
import type { Settings } from "../config/settings.js";
import type { Db } from "../db/db.js";
import { buildDailyReport } from "./build.js";
import { renderReportHtml } from "./render.js";
import { assertDay } from "../core/time.js";
import type { DailyReport } from "./types.js";

export interface WrittenReport {
  json: string; // path to <day>.json
  html: string; // path to <day>.html
  report: DailyReport;
}

export function writeDailyReport(db: Db, day: string, settings: Settings): WrittenReport {
  assertDay(day); // also keeps the file name inside REPORTS_DIR
  const report = buildDailyReport(db, day, settings);
  mkdirSync(REPORTS_DIR, { recursive: true });
  const json = path.join(REPORTS_DIR, `${day}.json`);
  const html = path.join(REPORTS_DIR, `${day}.html`);
  writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(html, renderReportHtml(report));
  return { json, html, report };
}
