import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LETTERS_DIR, ME_DIR, REPORTS_DIR, SCREENSHOTS_DIR } from "../config/paths.js";
import { saveSettings, SettingsSchema } from "../config/settings.js";
import { logEvent } from "../core/events.js";
import { haltInfo } from "../core/halt.js";
import { getKv, setKv } from "../db/db.js";
import { DRAFT_FILES, type DraftFile } from "../me/draft.js";
import {
  acceptDraft,
  applyAdvancedYaml,
  applyProfileForm,
  discardDraft,
  issuesOf,
  readProfileDoc,
  saveAnswers,
  saveLinkedin,
  savePrivate,
  saveProfileDoc,
  saveTextFile,
  TEXT_FILES,
  type TextFile,
} from "../me/edit.js";
import type { ConfirmAnswer, PendingConfirm } from "../pipeline/confirm.js";
import type { ApiResult } from "./api.js";
import { type Ctx, HttpError } from "./context.js";
import { letterHref, screenshotHref } from "./pages.js";
import { TASK_KINDS, type TaskInput } from "./tasks.js";

type Body = Record<string, unknown>;
const ok = (body: unknown): ApiResult => ({ status: 200, body });
const invalid = (issues: string[]): ApiResult => ({ status: 400, body: { error: issues[0] ?? "Invalid", issues } });

// ---------- Tasks

function startTask(ctx: Ctx, body: Body): ApiResult {
  const kind = body.kind;
  if (typeof kind !== "string" || !(TASK_KINDS as string[]).includes(kind)) throw new HttpError(400, "Unknown task");
  if (kind === "apply-live" || kind === "apply-nuworks-live") throw new HttpError(400, "Start live runs with the Apply for real button");
  if (haltInfo(ctx.db) && (kind === "apply-dry" || kind === "daily")) throw new HttpError(409, "Halted after an accepted offer.");
  const input = (body.input && typeof body.input === "object" ? body.input : {}) as TaskInput;
  delete input.liveToken;
  const task = ctx.tasks.start(kind, input);
  logEvent(ctx.db, { kind: "task.started", message: `${task.label} started from the app` });
  return ok({ ok: true, task: view(ctx, task.id) });
}

function view(ctx: Ctx, id: string) {
  const t = ctx.tasks.get(id);
  if (!t) return null;
  const output = ctx.tasks.output(t);
  const pdf = output.match(/^PDF: (.+\.pdf)$/m)?.[1];
  return { ...t, output, pdfHref: pdf ? letterHref(pdf) : null };
}

function getTask(ctx: Ctx, id: string): ApiResult {
  const v = view(ctx, id);
  if (!v) throw new HttpError(404, "Unknown task (the app may have restarted)");
  return ok(v);
}

// ---------- Live confirmations

function pending(ctx: Ctx): ApiResult {
  const p = getKv<PendingConfirm | null>(ctx.db, "apply.pending", null);
  if (!p) return ok({ pending: null, running: Boolean(ctx.tasks.running("apply-live")) });
  return ok({ pending: { id: p.id, summary: p.summary, at: p.at, screenshot: screenshotHref(p.screenshot) }, running: true });
}

function confirm(ctx: Ctx, body: Body): ApiResult {
  const p = getKv<PendingConfirm | null>(ctx.db, "apply.pending", null);
  if (!p || body.id !== p.id) throw new HttpError(409, "That application is no longer waiting");
  if (body.decision !== "submit" && body.decision !== "skip") throw new HttpError(400, '"decision" must be submit or skip');
  if (body.decision === "submit" && haltInfo(ctx.db)) throw new HttpError(409, "Halted after an accepted offer.");
  setKv(ctx.db, "apply.answer", { id: p.id, decision: body.decision } satisfies ConfirmAnswer);
  logEvent(ctx.db, { kind: "apply.confirm", message: `You chose ${body.decision} for: ${p.summary.split("\n")[0]}` });
  return ok({ ok: true });
}

// ---------- Profile and friends

function saveProfile(ctx: Ctx, body: Body): ApiResult {
  const base = readProfileDoc(body.fromDraft === true).doc;
  let doc = body.form && typeof body.form === "object" ? applyProfileForm(base, body.form as Record<string, unknown>) : base;
  if (typeof body.advanced === "string") {
    const next = applyAdvancedYaml(doc, body.advanced);
    if ("error" in next) return invalid([String(next.error)]);
    doc = next;
  }
  const r = saveProfileDoc(ctx.db, doc);
  if (!r.ok) return invalid(r.issues);
  logEvent(ctx.db, { kind: "profile.saved", message: "Profile saved in the app" });
  return ok({ ok: true });
}

function saveLinkedinLink(ctx: Ctx, body: Body): ApiResult {
  if (typeof body.url !== "string" || !body.url.trim()) throw new HttpError(400, "Paste your LinkedIn profile link");
  const r = saveLinkedin(ctx.db, body.url);
  if (!r.ok) return invalid(r.issues);
  logEvent(ctx.db, { kind: "profile.linkedin", message: "LinkedIn link saved" });
  return ok({ ok: true });
}

function savePrivateForm(_ctx: Ctx, body: Body): ApiResult {
  const f = (k: string) => (typeof body[k] === "string" ? (body[k] as string).trim() : "");
  const other: Record<string, string> = {};
  for (const line of f("other").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) other[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const address = { street: f("street"), city: f("city"), state: f("state"), zip: f("zip"), country: f("country") || "United States" };
  const r = savePrivate({
    ...(f("dateOfBirth") ? { dateOfBirth: f("dateOfBirth") } : {}),
    ...(Object.values(address).some((v) => v && v !== "United States") ? { address: Object.fromEntries(Object.entries(address).filter(([, v]) => v)) } : {}),
    ...(f("nuid") ? { nuid: f("nuid") } : {}),
    eeo: { gender: f("gender"), race: f("race"), hispanicLatino: f("hispanicLatino"), veteran: f("veteran"), disability: f("disability") },
    other,
  });
  return r.ok ? ok({ ok: true }) : invalid(r.issues);
}

function saveAnswerBank(ctx: Ctx, body: Body): ApiResult {
  if (!Array.isArray(body.answers)) throw new HttpError(400, '"answers" must be a list');
  const answers = body.answers
    .filter((a): a is Body => !!a && typeof a === "object")
    .map((a) => ({
      id: String(a.id ?? "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, ""),
      match: String(a.match ?? "").split(",").map((m) => m.trim()).filter(Boolean),
      answer: String(a.answer ?? "").trim(),
    }))
    .filter((a) => a.id || a.answer);
  const r = saveAnswers(ctx.db, answers);
  return r.ok ? ok({ ok: true, count: answers.length }) : invalid(r.issues);
}

function saveText(ctx: Ctx, name: string, body: Body): ApiResult {
  if (!(TEXT_FILES as readonly string[]).includes(name)) throw new HttpError(404, "Not found");
  if (typeof body.text !== "string") throw new HttpError(400, '"text" is required');
  const r = saveTextFile(ctx.db, name as TextFile, body.text);
  return r.ok ? ok({ ok: true }) : invalid(r.issues);
}

function draftAction(ctx: Ctx, name: string, action: string): ApiResult {
  if (!(DRAFT_FILES as readonly string[]).includes(name)) throw new HttpError(404, "No such draft");
  if (action === "discard") {
    discardDraft(name as DraftFile);
    return ok({ ok: true });
  }
  const r = acceptDraft(ctx.db, name as DraftFile);
  return r.ok ? ok({ ok: true }) : invalid(r.issues);
}

// ---------- Settings

const lines = (v: unknown) =>
  String(v ?? "")
    .split(/[\r\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
const num = (v: unknown) => (typeof v === "number" ? v : Number(String(v ?? "").trim()));

function saveSettingsForm(ctx: Ctx, body: Body): ApiResult {
  const s = structuredClone(ctx.settings);
  const f = body as Record<string, unknown>;
  s.cycle.label = String(f["cycle.label"] ?? s.cycle.label).trim();
  if (f["nuworks.terms"] !== undefined) s.nuworks.terms = lines(f["nuworks.terms"]);
  s.cycle.cap = num(f["cycle.cap"] ?? s.cycle.cap);
  s.cycle.reserve = num(f["cycle.reserve"] ?? s.cycle.reserve);
  s.nuworks.weeklyLimit = num(f["nuworks.weeklyLimit"] ?? s.nuworks.weeklyLimit);
  s.nuworks.minScore = num(f["nuworks.minScore"] ?? s.nuworks.minScore);
  s.nuworks.maxPerEmployer = num(f["nuworks.maxPerEmployer"] ?? s.nuworks.maxPerEmployer);
  s.nuworks.coverLetters = f["nuworks.coverLetters"] === "whenAccepted" ? "whenAccepted" : "required";
  s.external.enabled = f["external.enabled"] === true;
  s.external.repos = lines(f["external.repos"]).map((r) => r.replace(/\/+$/, ""));
  s.external.terms = lines(f["external.terms"]);
  s.external.maxPerDay = num(f["external.maxPerDay"] ?? s.external.maxPerDay);
  s.external.maxPerCompany = num(f["external.maxPerCompany"] ?? s.external.maxPerCompany);
  s.external.postedWithinDays = num(f["external.postedWithinDays"] ?? s.external.postedWithinDays);
  s.external.minRelevance = num(f["external.minRelevance"] ?? s.external.minRelevance);
  s.external.coverLetters = f["external.coverLetters"] === "whenAccepted" ? "whenAccepted" : "required";
  for (const a of ["greenhouse", "lever", "ashby"] as const) {
    const v = f[`external.adapters.${a}`];
    if (v === "off" || v === "supervised" || v === "auto") s.external.adapters[a] = v;
  }
  s.schedule.dailyTime = String(f["schedule.dailyTime"] ?? s.schedule.dailyTime).trim();
  s.schedule.weekdaysOnly = f["schedule.weekdaysOnly"] === true;
  const parsed = SettingsSchema.safeParse(s);
  if (!parsed.success) return invalid(issuesOf(parsed.error));
  ctx.settings = saveSettings(parsed.data, ctx.settingsFile);
  logEvent(ctx.db, { kind: "settings.saved", message: "Settings saved in the app" });
  return ok({ ok: true });
}

// ---------- Opening things on the Mac

const FOLDERS: Record<string, () => string> = {
  me: () => ME_DIR,
  letters: () => LETTERS_DIR,
  reports: () => REPORTS_DIR,
  screenshots: () => SCREENSHOTS_DIR,
};

function openFolder(body: Body): ApiResult {
  const which = typeof body.which === "string" && Object.hasOwn(FOLDERS, body.which) ? FOLDERS[body.which]() : null;
  if (!which) throw new HttpError(400, "Unknown folder");
  mkdirSync(which, { recursive: true });
  execFile("/usr/bin/open", [which]);
  return ok({ ok: true });
}

// Opens Terminal running `claude auth login`; the login itself happens in your browser.
function openClaudeLogin(): ApiResult {
  execFile("/usr/bin/osascript", ["-e", 'tell application "Terminal" to do script "claude auth login"', "-e", 'tell application "Terminal" to activate']);
  return ok({ ok: true });
}

// ---------- Uploads (raw bodies; see server.ts)

export const UPLOAD_KINDS = ["resume", "linkedin", "sample"] as const;

export function saveUpload(ctx: Ctx, kind: string, name: string | null, data: Buffer): ApiResult {
  if (!(UPLOAD_KINDS as readonly string[]).includes(kind)) throw new HttpError(404, "Not found");
  if (!data.length) throw new HttpError(400, "Empty file");
  const isPdf = data.subarray(0, 5).toString("latin1") === "%PDF-";
  let target: string;
  if (kind === "sample") {
    const base = path.basename(name ?? "").replace(/[^A-Za-z0-9._ -]+/g, "_").slice(0, 80);
    const ext = path.extname(base).toLowerCase();
    if (![".pdf", ".txt", ".md"].includes(ext)) throw new HttpError(415, "Writing samples can be PDF, .txt, or .md");
    if (ext === ".pdf" && !isPdf) throw new HttpError(415, "That file isn't a real PDF");
    target = path.join(ME_DIR, "samples", base || `sample-${Date.now()}${ext}`);
  } else {
    if (!isPdf) throw new HttpError(415, "Please upload a PDF");
    target = path.join(ME_DIR, kind === "resume" ? "resume.pdf" : "linkedin.pdf");
  }
  mkdirSync(path.dirname(target), { recursive: true });
  const replaced = existsSync(target);
  writeFileSync(target, data);
  logEvent(ctx.db, { kind: "upload", message: `${replaced ? "Replaced" : "Added"} ${path.relative(ME_DIR, target)}` });
  return ok({ ok: true, file: path.relative(ME_DIR, target), replaced });
}

// ---------- Router

export function handleSetupApi(ctx: Ctx, method: string, pathname: string, body: Body): ApiResult | null {
  let m: RegExpMatchArray | null;
  if (method === "GET") {
    if (pathname === "/api/tasks") return ok({ tasks: ctx.tasks.list().map((t) => ({ ...t, log: undefined })) });
    if ((m = pathname.match(/^\/api\/tasks\/([\w-]+)$/))) return getTask(ctx, m[1]);
    if (pathname === "/api/apply/pending") return pending(ctx);
    return null;
  }
  if (method !== "POST") return null;
  if (pathname === "/api/tasks") return startTask(ctx, body);
  if (pathname === "/api/apply/confirm") return confirm(ctx, body);
  if (pathname === "/api/profile") return saveProfile(ctx, body);
  if (pathname === "/api/private") return savePrivateForm(ctx, body);
  if (pathname === "/api/linkedin") return saveLinkedinLink(ctx, body);
  if (pathname === "/api/answers") return saveAnswerBank(ctx, body);
  if ((m = pathname.match(/^\/api\/text\/([\w.-]+)$/))) return saveText(ctx, m[1], body);
  if ((m = pathname.match(/^\/api\/drafts\/([\w.-]+)\/(accept|discard)$/))) return draftAction(ctx, m[1], m[2]);
  if (pathname === "/api/settings") return saveSettingsForm(ctx, body);
  if (pathname === "/api/open/folder") return openFolder(body);
  if (pathname === "/api/open/claude-login") return openClaudeLogin();
  return null;
}
