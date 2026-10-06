// Pre-commit privacy check. Two rules:
// 1. Never commit files from me/, data/, .auth/, or private fixtures.
// 2. Never commit text containing your email, phone, birthday, address, or NUID,
//    read from me/profile.yaml and me/private.yaml on this machine.
// Your name is not checked: it is already public in LICENSE and the repo URL.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const staged = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

const forbiddenPaths = [/^me\//, /^data\//, /^\.auth\//, /^test\/fixtures\/private\//, /^config\/settings\.yaml$/, /(^|\/)\.env(\.|$)/];
const badPaths = staged.filter((f) => forbiddenPaths.some((re) => re.test(f)));

function grab(file, keys) {
  const p = path.join(root, "me", file);
  if (!existsSync(p)) return [];
  const text = readFileSync(p, "utf8");
  const out = [];
  for (const key of keys) {
    for (const m of text.matchAll(new RegExp(`^\\s*${key}:\\s*["']?([^"'\\n#]+)`, "gm"))) {
      const v = m[1].trim();
      if (v.length >= 5) out.push(v);
    }
  }
  return out;
}

const secrets = [
  ...grab("profile.yaml", ["email", "phone"]),
  ...grab("private.yaml", ["dateOfBirth", "street", "zip", "nuid"]),
];
const digits = (s) => s.replace(/\D/g, "");

const diff = execFileSync("git", ["diff", "--cached", "-U0", "--no-color"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const added = diff
  .split("\n")
  .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
  .join("\n");
const addedDigits = digits(added);
const leaks = secrets.filter((s) => added.toLowerCase().includes(s.toLowerCase()) || (digits(s).length >= 7 && addedDigits.includes(digits(s))));

if (badPaths.length || leaks.length) {
  console.error("✘ Commit blocked by NU Portal privacy check.");
  for (const f of badPaths) console.error(`  private file staged: ${f}`);
  if (leaks.length) console.error(`  personal details found in staged changes (${leaks.length} match${leaks.length > 1 ? "es" : ""}); remove them before committing.`);
  process.exit(1);
}
