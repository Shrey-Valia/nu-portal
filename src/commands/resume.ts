import path from "node:path";
import { getBrain } from "../brain/index.js";
import { LETTERS_DIR } from "../config/paths.js";
import { finishRun, startRun } from "../core/events.js";
import { openDb } from "../db/db.js";
import { loadMe } from "../me/load.js";
import { draftResumes } from "../pipeline/nuworks.js";
import { pageCount, renderResume, resumeFileName } from "../resume/tailor.js";
import { untailored } from "../resume/template.js";

// npm run resume -- preview   the resume NU Portal builds from your profile (compare it with your real one)
// npm run resume -- tailor    tailored resumes for queued and approved NUworks jobs that don't have one yet
export default async function resume(argv: string[]): Promise<number> {
  const me = loadMe();
  if (argv[0] === "preview") {
    const out = path.join(LETTERS_DIR, "resumes", "preview", resumeFileName(me.profile, "Preview"));
    await renderResume(me.profile, untailored(me.profile), out);
    console.log(`Built from your profile (${pageCount(out)} page${pageCount(out) === 1 ? "" : "s"}). Compare it with your real resume; fix anything off on the Profile page.`);
    console.log(`PDF: ${out}`);
    return 0;
  }
  if (argv[0] === "tailor") {
    console.log("Tailoring resumes for queued and approved NUworks jobs (about a minute each)…");
    const db = openDb();
    const runId = startRun(db, "resumes");
    const { written } = await draftResumes(db, getBrain(), me, runId);
    finishRun(db, runId, "ok", { written });
    console.log(`Tailored ${written} resume${written === 1 ? "" : "s"}. They're on each job's card on Today.`);
    return 0;
  }
  console.error("Usage: npm run resume -- preview | tailor");
  return 2;
}
