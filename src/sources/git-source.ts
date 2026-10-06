import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { SOURCES_DIR } from "../config/paths.js";
import { execFileAsync } from "../core/util.js";

// GitHub's own rules: owners are alphanumeric with single inner hyphens (max 39);
// repo names are [A-Za-z0-9._-]. Leading "-" is refused so nothing can look like a git flag.
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const NAME = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,99}$/;

export class RepoSlugError extends Error {}

// Accepts "owner/name" or "https://github.com/owner/name" (optional ".git" or trailing "/"), nothing else.
export function parseRepoSlug(input: string): { owner: string; name: string; repo: string } {
  const text = input.trim();
  const m = text.match(/^https:\/\/github\.com\/([^/?#\s]+)\/([^/?#\s]+?)\/?$/) ?? text.match(/^([^/:?#\s]+)\/([^/?#\s]+)$/);
  const owner = m?.[1] ?? "";
  const name = (m?.[2] ?? "").replace(/\.git$/, "");
  if (!OWNER.test(owner) || !NAME.test(name) || name === "." || name === "..") {
    throw new RepoSlugError(`Not a GitHub repo: "${input}". Use owner/name or https://github.com/owner/name.`);
  }
  return { owner, name, repo: `${owner}/${name}` };
}

export function repoDir(repoUrlOrSlug: string): string {
  const { owner, name } = parseRepoSlug(repoUrlOrSlug);
  const root = path.resolve(SOURCES_DIR);
  const dir = path.resolve(root, `${owner}__${name}`);
  if (path.dirname(dir) !== root) throw new RepoSlugError(`Refusing to use ${dir}: not directly inside ${root}`);
  return dir;
}

async function git(args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-c", "credential.helper=", ...args], {
      cwd,
      // A missing or private repo makes GitHub ask for credentials; fail instead of hanging.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      timeout: 5 * 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return String(stdout);
  } catch (err) {
    const stderr = (err as { stderr?: unknown }).stderr;
    const detail = typeof stderr === "string" && stderr.trim() ? stderr.trim() : (err as Error).message;
    throw new Error(`git ${args[0]} failed: ${detail}`);
  }
}

// Shallow clone on first use, then fetch + hard reset. Only ever touches SOURCES_DIR/<owner>__<name>.
export async function pullRepo(repoUrlOrSlug: string): Promise<{ dir: string; repo: string; sha: string }> {
  const { repo } = parseRepoSlug(repoUrlOrSlug);
  const dir = repoDir(repo);
  mkdirSync(SOURCES_DIR, { recursive: true });
  if (existsSync(path.join(dir, ".git"))) {
    await git(["fetch", "--quiet", "--depth", "1", "origin"], dir);
    await git(["reset", "--quiet", "--hard", "origin/HEAD"], dir);
  } else if (existsSync(dir)) {
    throw new Error(`${dir} exists but is not a git checkout. Remove it and pull again.`);
  } else {
    try {
      await git(["clone", "--quiet", "--depth", "1", `https://github.com/${repo}.git`, dir]);
    } catch (err) {
      throw new Error(`Could not clone ${repo} (is it public and spelled right?). ${(err as Error).message}`);
    }
  }
  const sha = (await git(["rev-parse", "HEAD"], dir)).trim();
  return { dir, repo, sha };
}
