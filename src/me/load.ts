import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { ME_DIR } from "../config/paths.js";
import { shortHash } from "../core/util.js";
import { type AnswerBank, AnswerBankSchema, type PrivateInfo, PrivateSchema, type Profile, ProfileSchema } from "./schema.js";

export interface Story {
  id: string;
  title: string;
  body: string;
}

export interface Me {
  profile: Profile;
  stories: Story[];
  voice: string;
  preferences: string;
  answers: AnswerBank;
  files: { resume: string | null; linkedin: string | null; samples: string[] };
  // Changes whenever anything the AI sees changes; scores remember which version they used.
  version: string;
}

const read = (name: string) => {
  const file = path.join(ME_DIR, name);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
};

export class MeMissingError extends Error {}

export function loadMe(): Me {
  const profileText = read("profile.yaml");
  if (!profileText) {
    throw new MeMissingError("me/profile.yaml not found. Open the app (npm start) → Setup → Build your profile.");
  }
  const profile = ProfileSchema.parse(parse(profileText));
  const storiesText = read("stories.md") ?? "";
  const voice = read("voice.md") ?? "";
  const preferences = read("preferences.md") ?? "";
  const answers = AnswerBankSchema.parse(parse(read("answers.yaml") ?? "[]") ?? []);
  const pick = (re: RegExp) => {
    if (!existsSync(ME_DIR)) return null;
    const f = readdirSync(ME_DIR).find((n) => re.test(n));
    return f ? path.join(ME_DIR, f) : null;
  };
  const samplesDir = path.join(ME_DIR, "samples");
  const samples = existsSync(samplesDir)
    ? readdirSync(samplesDir)
        .filter((f) => !f.startsWith("."))
        .map((f) => path.join(samplesDir, f))
    : [];
  return {
    profile,
    stories: parseStories(storiesText),
    voice,
    preferences,
    answers,
    files: { resume: pick(/^resume\.pdf$/i), linkedin: pick(/^linkedin\.pdf$/i), samples },
    version: shortHash([profileText, storiesText, voice, preferences].join("\n\u0000\n")),
  };
}

export function loadPrivate(): PrivateInfo {
  const text = read("private.yaml");
  return PrivateSchema.parse(text ? parse(text) ?? {} : {});
}

// Stories are "## [story:some-id] Title" sections in me/stories.md.
export function parseStories(md: string): Story[] {
  const out: Story[] = [];
  const re = /^##\s*\[story:([a-z0-9-]+)\]\s*(.*)$/gm;
  const marks = [...md.matchAll(re)];
  marks.forEach((m, i) => {
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index : md.length;
    out.push({ id: m[1], title: m[2].trim(), body: md.slice(start, end).trim() });
  });
  return out;
}

// Every id a cover-letter claim is allowed to cite.
export function knownSourceIds(me: Me): Set<string> {
  const p = me.profile;
  return new Set([
    "education",
    ...p.skills.map((s) => s.id),
    ...p.experiences.flatMap((e) => [e.id, ...e.bullets.map((b) => b.id)]),
    ...p.awards.map((a) => a.id),
    ...p.extras.map((x) => x.id),
    ...me.stories.map((s) => `story:${s.id}`),
  ]);
}

// What the AI gets to see: no phone, email, or anything from private.yaml.
export function profileForBrain(me: Me): string {
  const { identity, ...rest } = me.profile;
  const view = {
    name: identity.preferredName ?? identity.name,
    city: identity.city,
    links: identity.links,
    ...rest,
    education: { ...rest.education, gpa: rest.education.shareGpa ? rest.education.gpa : undefined },
  };
  return JSON.stringify(view, null, 1);
}
