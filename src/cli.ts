// Single entry point: `node --import tsx src/cli.ts <command> [args]`.
// package.json scripts and launchd agents all go through here.

type Command = { default: (args: string[]) => Promise<number | void> };

const COMMANDS: Record<string, { load: () => Promise<Command>; help: string }> = {
  login: { load: () => import("./commands/login.js"), help: "Open Chrome on NUworks so you can sign in (SSO + Duo)" },
  "session:check": { load: () => import("./commands/session-check.js"), help: "Check whether your saved NUworks session still works" },
  doctor: { load: () => import("./commands/doctor.js"), help: "Check setup (--brain, --session, --launchd)" },
  backup: { load: () => import("./commands/backup.js"), help: "Snapshot the database to data/backups" },
  "profile:check": { load: () => import("./commands/profile-check.js"), help: "Show what NU Portal knows about you, and what's missing" },
  "letter:sample": { load: () => import("./commands/letter-sample.js"), help: "Draft + humanize a letter or answer for a pasted posting" },
  daily: { load: () => import("./commands/daily.js"), help: "Run the morning pipeline (--fixture file.json to use test data)" },
  serve: { load: () => import("./server/serve.js"), help: "Open the local dashboard (--port N)" },
  report: { load: () => import("./report/command.js"), help: "Write the daily report (--day YYYY-MM-DD)" },
  "sources:pull": { load: () => import("./commands/sources-pull.js"), help: "Pull a GitHub job-list repo and show listing counts by term" },
  recon: { load: () => import("./commands/recon.js"), help: "Phase 2: open NUworks for read-only mapping with the recon MCP servers" },
  apply: { load: () => import("./commands/apply.js"), help: "Apply to approved jobs (--track external, --mode dry-run|live, --headed)" },
  offer: { load: () => import("./commands/offer.js"), help: "Offer-accepted kill switch: accept | status | clear" },
  schedule: { load: () => import("./commands/schedule.js"), help: "Install or remove the launchd schedule: install | uninstall" },
};

async function main(): Promise<number> {
  const [name, ...args] = process.argv.slice(2);
  if (!name || name === "help" || name === "--help") {
    console.log("NU Portal commands:\n");
    for (const [cmd, { help }] of Object.entries(COMMANDS)) console.log(`  ${cmd.padEnd(16)} ${help}`);
    return 0;
  }
  const entry = COMMANDS[name];
  if (!entry) {
    console.error(`Unknown command "${name}". Run: npm run nup -- help`);
    return 2;
  }
  const mod = await entry.load();
  return (await mod.default(args)) ?? 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    if (process.env.NUPORTAL_DEBUG) console.error(err);
    process.exit(1);
  },
);
