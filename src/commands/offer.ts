import { parseArgs } from "node:util";
import { CLEAR_PHRASE, clearHalt, haltInfo, notifyList, setHalt } from "../core/halt.js";
import { openDb } from "../db/db.js";

// npm run offer -- accept --employer "Acme" --date 2026-11-02
// npm run offer -- status
// npm run offer -- clear --confirm "I accepted no offer"
export default async function offer(argv: string[]): Promise<number> {
  const [action, ...rest] = argv;
  const { values } = parseArgs({ args: rest, options: { employer: { type: "string" }, date: { type: "string" }, confirm: { type: "string" } } });
  const db = openDb();
  if (action === "accept") {
    if (!values.employer) {
      console.error('Usage: npm run offer -- accept --employer "Acme" [--date YYYY-MM-DD]');
      return 2;
    }
    const { halted } = setHalt(db, values.employer, values.date ?? new Date().toISOString().slice(0, 10));
    console.log(`Congratulations! All applying is stopped. ${halted} pending jobs halted.\n`);
  } else if (action === "clear") {
    if (!clearHalt(db, values.confirm ?? "")) {
      console.error(`To clear the kill switch, pass --confirm "${CLEAR_PHRASE}"`);
      return 2;
    }
    console.log("Kill switch cleared.");
    return 0;
  } else if (action !== "status") {
    console.error("Usage: npm run offer -- accept|status|clear");
    return 2;
  }
  const info = haltInfo(db);
  if (!info) {
    console.log("No offer recorded; applying is active.");
    return 0;
  }
  console.log(`Offer accepted at ${info.employer} on ${info.date}.\n\nNext steps (Northeastern co-op handbook):`);
  console.log("  1. Record and accept the offer in NUworks: Student Utilities → My Co-op Job Search → Record an Offer (required for Spring 2027 co-ops).");
  console.log("  2. Tell your co-op coordinator/advisor you accepted.");
  console.log("  3. Withdraw your other NUworks applications.");
  console.log("  4. Let these employers know you're no longer available:");
  for (const r of notifyList(db)) console.log(`     - ${r.employer}: ${r.title} (${r.status})`);
  return 0;
}
