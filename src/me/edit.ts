import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import type { z } from "zod";
import { ME_DIR, ROOT } from "../config/paths.js";
import { type Db, now } from "../db/db.js";
import { DRAFTS_DIR, type DraftFile, parseDraftProfile, readDraft } from "./draft.js";
import { withScheme } from "./edit-utils.js";
import { AnswerBankSchema, type PrivateInfo, PrivateSchema, ProfileSchema } from "./schema.js";

// Reading and saving the me/ files from the app. Every save is validated with
// the same schemas the pipeline uses, and the previous version is kept in
// profile_versions.

export type Doc = Record<string, unknown>;
export type SaveResult = { ok: true } | { ok: false; issues: string[] };

const file = (name: string) => path.join(ME_DIR, name);
const readText = (name: string) => (existsSync(file(name)) ? readFileSync(file(name), "utf8") : null);

// Zod issues in words a person can act on, using the form's labels where possible.
export function issuesOf(err: z.ZodError): string[] {
  return err.issues.map((i) => {
    const p = i.path.join(".");
    const label = PROFILE_FIELDS.find((f) => f.path === p)?.label ?? (p || "profile");
    const msg = /received undefined/.test(i.message) ? "please fill this in" : i.message.replace(/^Invalid input: /, "");
    return `${label}: ${msg}`;
  });
}

function snapshot(db: Db, name: string): void {
  const prev = readText(name);
  if (prev !== null) db.prepare("INSERT INTO profile_versions (created_at, file, content, source) VALUES (?, ?, ?, 'user')").run(now(), name, prev);
}

function write(name: string, text: string, mode?: number): void {
  mkdirSync(ME_DIR, { recursive: true });
  writeFileSync(file(name), text);
  if (mode) chmodSync(file(name), mode);
}

// ---------- profile.yaml

export function readProfileDoc(preferDraft = false): { doc: Doc; source: "profile" | "draft" | "template" } {
  const text = readText("profile.yaml");
  if (text && !preferDraft) return { doc: (parse(text) as Doc) ?? {}, source: "profile" };
  const draft = parseDraftProfile();
  if (draft) return { doc: draft, source: "draft" };
  if (text) return { doc: (parse(text) as Doc) ?? {}, source: "profile" };
  return { doc: {}, source: "template" };
}

export function profileExists(): boolean {
  return existsSync(file("profile.yaml"));
}

export function profileValid(): boolean {
  const text = readText("profile.yaml");
  return !!text && ProfileSchema.safeParse(parse(text)).success;
}

export function saveProfileDoc(db: Db, doc: Doc): SaveResult {
  const parsed = ProfileSchema.safeParse(doc);
  if (!parsed.success) return { ok: false, issues: issuesOf(parsed.error) };
  snapshot(db, "profile.yaml");
  write("profile.yaml", `# Your NU Portal profile. Edit in the app (Setup → Profile) or here.\n${stringify(doc, { lineWidth: 0 })}`);
  rmSync(path.join(DRAFTS_DIR(), "profile.yaml"), { force: true }); // draft has been reviewed
  return { ok: true };
}

type FieldType = "text" | "list" | "number" | "int" | "bool" | "tri" | "multi";

// The form fields on the Profile page and where they live in profile.yaml.
export const PROFILE_FIELDS: { path: string; label: string; type: FieldType; required?: boolean; options?: string[]; hint?: string; default?: boolean }[] = [
  { path: "identity.name", label: "Full name", type: "text", required: true },
  { path: "identity.preferredName", label: "Preferred first name", type: "text" },
  { path: "identity.email", label: "Email", type: "text", required: true },
  { path: "identity.phone", label: "Phone", type: "text" },
  { path: "identity.city", label: "City", type: "text", hint: "e.g. Boston, MA" },
  { path: "identity.pronouns", label: "Pronouns", type: "text", hint: "optional" },
  { path: "identity.links.linkedin", label: "LinkedIn URL", type: "text" },
  { path: "identity.links.github", label: "GitHub URL", type: "text" },
  { path: "identity.links.website", label: "Website", type: "text" },
  { path: "education.school", label: "School", type: "text" },
  { path: "education.college", label: "College", type: "text", hint: "e.g. Khoury College of Computer Sciences" },
  { path: "education.degree", label: "Degree", type: "text", hint: "BS, BA, MS…" },
  { path: "education.majors", label: "Major(s)", type: "list", required: true },
  { path: "education.minors", label: "Minor(s)", type: "list" },
  { path: "education.gradDate", label: "Graduation", type: "text", required: true, hint: "e.g. May 2028" },
  { path: "education.level", label: "Year", type: "text", options: ["first-year", "second-year", "middler", "fourth-year", "senior", "graduate"] },
  { path: "education.gpa", label: "GPA", type: "number" },
  { path: "education.shareGpa", label: "OK to share GPA", type: "bool", default: true },
  { path: "education.coopCycle", label: "Co-op cycle", type: "text", required: true, hint: "e.g. Spring 2027" },
  { path: "education.coopNumber", label: "Which co-op", type: "int", required: true, options: ["1", "2", "3"] },
  { path: "education.coursework", label: "Relevant courses", type: "list" },
  { path: "workAuth.authorizedUS", label: "Authorized to work in the US", type: "bool", required: true },
  { path: "workAuth.needsSponsorship", label: "Need visa sponsorship (now or later)", type: "bool", required: true },
  { path: "workAuth.usCitizen", label: "U.S. citizen", type: "tri", hint: "only used to skip citizenship-only postings" },
  { path: "workAuth.clearanceEligible", label: "Could get a security clearance", type: "tri" },
  { path: "targets.roles", label: "Roles you want", type: "list", required: true, hint: "one per line, e.g. Software Engineer Co-op" },
  { path: "targets.domains", label: "Industries you like", type: "list" },
  { path: "targets.locations", label: "Locations", type: "list", hint: "one per line, e.g. Boston, MA" },
  { path: "targets.modalities", label: "Work style", type: "multi", options: ["onsite", "hybrid", "remote"] },
  { path: "targets.willingToRelocate", label: "Willing to relocate", type: "bool", default: true },
  { path: "targets.minHourly", label: "Minimum pay ($/hr)", type: "number" },
  { path: "targets.companiesLove", label: "Dream companies", type: "list" },
  { path: "targets.companiesAvoid", label: "Companies to avoid", type: "list" },
  { path: "targets.keywordsAvoid", label: "Words that mean “not for me”", type: "list", hint: "e.g. unpaid, commission" },
  { path: "targets.dealbreakers", label: "Dealbreakers", type: "list" },
];

export const ADVANCED_KEYS = ["skills", "experiences", "awards", "extras"] as const;

export function getPath(doc: Doc, p: string): unknown {
  return p.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Doc)[k] : undefined), doc);
}

function setPath(doc: Doc, p: string, value: unknown): void {
  const keys = p.split(".");
  let o = doc;
  for (const k of keys.slice(0, -1)) {
    if (!o[k] || typeof o[k] !== "object") o[k] = {};
    o = o[k] as Doc;
  }
  const last = keys[keys.length - 1];
  if (value === undefined) delete o[last];
  else o[last] = value;
}

const lines = (v: unknown) =>
  String(v ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

// Applies the Profile form (field path -> raw form value) onto the document.
export function applyProfileForm(doc: Doc, form: Record<string, unknown>): Doc {
  const next = structuredClone(doc);
  for (const f of PROFILE_FIELDS) {
    if (!Object.hasOwn(form, f.path)) continue;
    const raw = form[f.path];
    let value: unknown;
    switch (f.type) {
      case "text":
        value = String(raw ?? "").trim() || undefined;
        if (value && f.path.startsWith("identity.links.")) value = withScheme(value as string) ?? undefined;
        break;
      case "list":
        value = lines(raw);
        break;
      case "number":
      case "int": {
        const t = String(raw ?? "").trim();
        value = t ? (f.type === "int" ? Number.parseInt(t, 10) : Number(t)) : undefined;
        break;
      }
      case "bool":
        value = raw === "" || raw === undefined || raw === null ? undefined : raw === true || raw === "true" || raw === "yes";
        break;
      case "tri":
        value = raw === "yes" ? true : raw === "no" ? false : undefined;
        break;
      case "multi":
        value = Array.isArray(raw) ? raw.filter((x) => typeof x === "string" && f.options?.includes(x)) : [];
        break;
    }
    setPath(next, f.path, value);
  }
  return next;
}

export function advancedYaml(doc: Doc): string {
  const part = Object.fromEntries(ADVANCED_KEYS.map((k) => [k, doc[k] ?? []]));
  return stringify(part, { lineWidth: 0 });
}

export function applyAdvancedYaml(doc: Doc, text: string): Doc | { error: string } {
  let part: unknown;
  try {
    part = parse(text);
  } catch (err) {
    return { error: `That isn't valid YAML: ${(err as Error).message.split("\n")[0]}` };
  }
  if (!part || typeof part !== "object" || Array.isArray(part)) return { error: "Expected sections like skills: and experiences:" };
  const extra = Object.keys(part).filter((k) => !(ADVANCED_KEYS as readonly string[]).includes(k));
  if (extra.length) return { error: `Only ${ADVANCED_KEYS.join(", ")} belong here (found ${extra.join(", ")})` };
  return { ...structuredClone(doc), ...(part as Doc) };
}

// ---------- private.yaml (form filling only; never sent to the AI)

export function readPrivate(): PrivateInfo {
  const text = readText("private.yaml");
  return PrivateSchema.parse(text ? parse(text) ?? {} : {});
}

export function privateExists(): boolean {
  return existsSync(file("private.yaml"));
}

export function savePrivate(input: unknown): SaveResult {
  const parsed = PrivateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: issuesOf(parsed.error) };
  write("private.yaml", `# Only used to fill form fields that ask for these. Never sent to the AI.\n${stringify(parsed.data)}`, 0o600);
  return { ok: true };
}

// ---------- answers.yaml, stories.md, voice.md, preferences.md

export function readAnswers() {
  return AnswerBankSchema.parse(parse(readText("answers.yaml") ?? "[]") ?? []);
}

export function saveAnswers(db: Db, input: unknown): SaveResult {
  const parsed = AnswerBankSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: issuesOf(parsed.error) };
  const ids = parsed.data.map((a) => a.id);
  const dup = ids.find((x, i) => ids.indexOf(x) !== i);
  if (dup) return { ok: false, issues: [`two answers share the id "${dup}"`] };
  snapshot(db, "answers.yaml");
  write("answers.yaml", stringify(parsed.data));
  return { ok: true };
}

export const TEXT_FILES = ["stories.md", "voice.md", "preferences.md"] as const;
export type TextFile = (typeof TEXT_FILES)[number];

export function readTextFile(name: TextFile): string {
  return readText(name) ?? readTemplate(name);
}

function readTemplate(name: TextFile): string {
  const t = path.join(ROOT, "templates", "me", name.replace(/\.md$/, ".example.md"));
  return existsSync(t) ? readFileSync(t, "utf8") : "";
}

export function saveTextFile(db: Db, name: TextFile, text: string): SaveResult {
  if (text.length > 200_000) return { ok: false, issues: ["too long"] };
  snapshot(db, name);
  write(name, text.replace(/\r\n?/g, "\n"));
  return { ok: true };
}

// ---------- drafts

export function acceptDraft(db: Db, name: DraftFile): SaveResult {
  const text = readDraft(name);
  if (text === null) return { ok: false, issues: ["no such draft"] };
  if (name === "profile.yaml") return { ok: false, issues: ["Open the profile draft on the Profile page to review and save it."] };
  const res = saveTextFile(db, name, text);
  if (res.ok) rmSync(path.join(DRAFTS_DIR(), name), { force: true });
  return res;
}

export function discardDraft(name: DraftFile): void {
  rmSync(path.join(DRAFTS_DIR(), name), { force: true });
}
