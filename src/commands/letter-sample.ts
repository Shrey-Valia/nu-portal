import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { getBrain } from "../brain/index.js";
import { LETTERS_DIR } from "../config/paths.js";
import { sanitizePosting } from "../core/sanitize.js";
import { renderPdf } from "../letters/render-pdf.js";
import { letterHtml } from "../letters/template.js";
import { loadMe } from "../me/load.js";
import { writeAnswer, writeCoverLetter } from "../writing/compose.js";

// Try the writing pipeline on a posting you paste into a text file:
//   npm run letter:sample -- --file posting.txt --employer "Acme" --title "SWE Co-op"
//   add --question "Why Acme?" to draft an application answer instead.
export default async function letterSample(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      file: { type: "string" },
      employer: { type: "string" },
      title: { type: "string" },
      question: { type: "string" },
      "max-chars": { type: "string" },
    },
  });
  if (!values.file || !values.employer || !values.title) {
    console.error('Usage: npm run letter:sample -- --file posting.txt --employer "Acme" --title "Software Engineer Co-op" [--question "Why us?"]');
    return 2;
  }
  const me = loadMe();
  const brain = getBrain();
  const posting = {
    id: "sample",
    title: values.title,
    employer: values.employer,
    location: null,
    modality: null,
    term: me.profile.education.coopCycle,
    pay: null,
    deadline: null,
    description: sanitizePosting(readFileSync(values.file, "utf8")),
  };

  const started = Date.now();
  const w = values.question
    ? await writeAnswer({ brain, me, posting, question: values.question, maxChars: values["max-chars"] ? Number(values["max-chars"]) : undefined })
    : await writeCoverLetter({ brain, me, posting });

  const rule = "─".repeat(72);
  console.log(`\n${rule}\nAI DRAFT (before humanizer)\n${rule}\n${w.draft}`);
  console.log(`\n${rule}\nFINAL (after humanizer)\n${rule}\n${w.body}`);
  console.log(`\n${rule}\nHumanizer fixed: ${w.humanizerChanges.join("; ") || "nothing"}`);
  console.log(`Claims: ${w.claims.map((c) => `${c.sourceId}`).join(", ") || "none"}`);
  console.log(w.lint.ok ? "Checks: all passed" : `Checks: ${w.lint.problems.join("; ")}`);
  if (w.needsHuman) console.log("The AI flagged this as needing your input.");

  if (w.kind === "cover_letter") {
    const date = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "America/New_York" });
    const slug = values.employer.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const out = path.join(LETTERS_DIR, "samples", `${slug}-${Date.now()}.pdf`);
    await renderPdf(letterHtml({ profile: me.profile, employer: values.employer, title: values.title, body: w.body, date }), out);
    console.log(`PDF: ${out}`);
  }
  console.log(`Took ${((Date.now() - started) / 1000).toFixed(0)} s\n`);
  return 0;
}
