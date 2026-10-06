import { parseArgs } from "node:util";
import { runDaily } from "../pipeline/daily.js";

// npm run daily [-- --fixture file.json] [--no-external] [--no-nuworks] [--no-letters]
export default async function daily(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      fixture: { type: "string" },
      via: { type: "string", default: "cli" },
      "no-external": { type: "boolean" },
      "no-nuworks": { type: "boolean" },
      "no-letters": { type: "boolean" },
    },
  });
  const s = await runDaily({
    fixture: values.fixture,
    via: values.via === "schedule" ? "schedule" : "cli",
    external: !values["no-external"],
    nuworks: !values["no-nuworks"],
    letters: !values["no-letters"],
  });
  console.log(JSON.stringify({ nuworks: s.nuworks, external: s.external }, null, 2));
  if (s.problems.length) console.log(`\nProblems:\n${s.problems.map((p) => `  ! ${p}`).join("\n")}`);
  if (s.reportHtml) console.log(`\nReport: ${s.reportHtml}`);
  return 0;
}
