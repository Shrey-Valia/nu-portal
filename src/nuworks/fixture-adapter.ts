import { readFileSync } from "node:fs";
import type { ApplicationsSnapshot, NuworksAdapter, Posting, PostingSummary } from "./adapter.js";

interface FixtureFile {
  postings: Posting[];
  applications?: ApplicationsSnapshot;
  resume?: { approved: boolean; name: string | null };
}

// Replays postings from a JSON file. Used by tests and `daily --fixture <file>`.
export class FixtureAdapter implements NuworksAdapter {
  readonly kind = "fixture";
  private data: FixtureFile;

  constructor(fileOrData: string | FixtureFile) {
    this.data = typeof fileOrData === "string" ? (JSON.parse(readFileSync(fileOrData, "utf8")) as FixtureFile) : fileOrData;
  }

  async search(): Promise<PostingSummary[]> {
    return this.data.postings.map(({ id, title, employer, location, deadlineAt, postedAt }) => ({ id, title, employer, location, deadlineAt, postedAt }));
  }

  async detail(id: string): Promise<Posting> {
    const p = this.data.postings.find((x) => x.id === id);
    if (!p) throw new Error(`fixture has no posting ${id}`);
    return p;
  }

  async applications(): Promise<ApplicationsSnapshot> {
    return this.data.applications ?? { rows: [], capCount: null, capShown: null };
  }

  async resumeStatus() {
    return this.data.resume ?? { approved: true, name: "Resume (fixture)" };
  }

  async close() {}
}
