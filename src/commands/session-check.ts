import { getKv, openDb } from "../db/db.js";
import { checkSession } from "../nuworks/session.js";

export default async function sessionCheck(): Promise<number> {
  const db = openDb();
  const loginAt = getKv<string | null>(db, "session.loginAt", null);
  const result = await checkSession(db);
  console.log(`${result.status}: ${result.detail}`);
  console.log(`final page: ${result.finalUrl}`);
  if (loginAt) {
    const hours = ((Date.now() - Date.parse(loginAt)) / 3_600_000).toFixed(1);
    console.log(`last manual login: ${loginAt} (${hours} h ago)`);
  }
  return result.status === "ok" || result.status === "sso_silent_ok" ? 0 : 1;
}
