import { backup, openDb } from "../db/db.js";

export default async function runBackup(): Promise<number> {
  console.log(`Saved ${backup(openDb())}`);
  return 0;
}
