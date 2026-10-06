import { loadSettings } from "../config/settings.js";
import { installAgent, uninstallAgent } from "../schedule/launchd.js";

const DAILY = "com.nuportal.daily";
const DASHBOARD = "com.nuportal.dashboard";

// npm run schedule -- install | uninstall
export default async function schedule(argv: string[]): Promise<number> {
  const action = argv[0];
  if (action === "uninstall") {
    await uninstallAgent(DAILY);
    await uninstallAgent(DASHBOARD);
    console.log("Removed the daily run and the dashboard from launchd.");
    return 0;
  }
  if (action !== "install") {
    console.error("Usage: npm run schedule -- install|uninstall");
    return 2;
  }
  const s = loadSettings();
  const [Hour, Minute] = s.schedule.dailyTime.split(":").map(Number);
  const days = s.schedule.weekdaysOnly ? [1, 2, 3, 4, 5] : [0, 1, 2, 3, 4, 5, 6];
  const daily = await installAgent({ label: DAILY, args: ["daily", "--via", "schedule"], calendar: days.map((Weekday) => ({ Hour, Minute, Weekday })) });
  const dash = await installAgent({ label: DASHBOARD, args: ["serve"], runAtLoad: true, keepAlive: true });
  console.log(`Daily run: ${s.schedule.dailyTime} ${s.schedule.weekdaysOnly ? "on weekdays" : "every day"} (runs on wake if the Mac was asleep)\n  ${daily}`);
  console.log(`Dashboard: http://127.0.0.1:${s.server.port} (always on)\n  ${dash}`);
  return 0;
}
