import { getBrain } from "../brain/index.js";
import { loadSettings } from "../config/settings.js";
import { buildDrafts, sourceFiles } from "../me/draft.js";

// Reads your resume, LinkedIn PDF, and writing samples and writes drafts to
// me/drafts/ for you to review (in the app: Setup → Review drafts).
export default async function profileBuild(): Promise<number> {
  const files = sourceFiles();
  console.log(`Reading ${files.length} file${files.length === 1 ? "" : "s"}: ${files.map((f) => f.split("/").slice(-1)[0]).join(", ")}`);
  console.log("This takes a minute or two…");
  const { written, questions } = await buildDrafts(getBrain(), loadSettings().cycle.label);
  console.log(`\nDrafts ready in me/drafts/: ${written.join(", ")}`);
  if (questions.length) console.log(`\nPlease confirm:\n${questions.map((q) => `  - ${q}`).join("\n")}`);
  console.log("\nReview them in the app (Setup → Review drafts) before they're used.");
  return 0;
}
