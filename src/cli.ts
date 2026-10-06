// Single entry point: `node --import tsx src/cli.ts <command> [args]`.
// package.json scripts and launchd agents all go through here.

type Command = { default: (args: string[]) => Promise<number | void> };

const COMMANDS: Record<string, { load: () => Promise<Command>; help: string }> = {
  login: { load: () => import("./commands/login.js"), help: "Open Chrome on NUworks so you can sign in (SSO + Duo)" },
  "session:check": { load: () => import("./commands/session-check.js"), help: "Check whether your saved NUworks session still works" },
  doctor: { load: () => import("./commands/doctor.js"), help: "Check setup (--brain, --session, --launchd)" },
  backup: { load: () => import("./commands/backup.js"), help: "Snapshot the database to data/backups" },
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
