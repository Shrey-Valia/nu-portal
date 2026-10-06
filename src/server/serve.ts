import { loadSettings } from "../config/settings.js";
import { openDb } from "../db/db.js";
import { startServer } from "./server.js";

// `nup serve [--port N]`: the local dashboard. Runs until Ctrl+C.
export default async function serve(args: string[]): Promise<number> {
  const settings = loadSettings();
  const i = args.indexOf("--port");
  const port = i >= 0 ? Number(args[i + 1]) : settings.server.port;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    console.error(`Expected --port 0-65535, got "${args[i + 1] ?? ""}"`);
    return 2;
  }
  const db = openDb();
  let server;
  try {
    server = await startServer({ db, port, settings });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
      console.error(`Port ${port} is busy. Is the dashboard already running? Try --port ${port + 1}.`);
      return 1;
    }
    throw err;
  }
  console.log(`NU Portal dashboard: ${server.url}`);
  console.log("Only this computer can reach it. Press Ctrl+C to stop.");
  const running = server;
  await new Promise<void>((resolve) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      running.close().finally(resolve);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  return 0;
}
