import { countByTerm, pullAndParse } from "../sources/index.js";

// npm run sources:pull -- <owner/name | https://github.com/owner/name>
export default async function sourcesPull(args: string[]): Promise<number> {
  if (!args[0]) {
    console.error("Usage: npm run sources:pull -- <owner/name | https://github.com/owner/name>");
    return 2;
  }
  const { listings, sha, repo } = await pullAndParse(args[0]);
  console.log(`${repo}@${sha.slice(0, 7)}: ${listings.length} listings (${listings.filter((l) => l.active).length} active)`);
  for (const [term, c] of Object.entries(countByTerm(listings)).sort((a, b) => b[1].active - a[1].active)) {
    console.log(`  ${term.padEnd(14)} ${String(c.active).padStart(5)} active / ${c.total}`);
  }
  return 0;
}
