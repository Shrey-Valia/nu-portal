import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ME_DIR } from "../config/paths.js";
import type { Settings } from "../config/settings.js";
import { which } from "../core/util.js";
import { getKv } from "../db/db.js";
import { listDrafts, readDraft } from "../me/draft.js";
import {
  advancedYaml,
  currentLinkedin,
  getPath,
  PROFILE_FIELDS,
  privateExists,
  profileExists,
  profileValid,
  readAnswers,
  readPrivate,
  readProfileDoc,
  readTextForEdit,
  type TextFile,
} from "../me/edit.js";
import { cleanSubmits, GRADUATION } from "../pipeline/apply-external.js";
import { sessionView } from "../report/present.js";
import type { Ctx } from "./context.js";
import { html, raw, type SafeHtml } from "./html.js";
import { empty, layout } from "./pages.js";

// ---------- Claude status (cached; `claude auth status` takes a moment)

let claudeCache: { at: number; value: ClaudeStatus } | null = null;
export interface ClaudeStatus {
  found: boolean;
  loggedIn: boolean;
  detail: string;
}

export async function claudeStatus(settings: Settings): Promise<ClaudeStatus> {
  if (claudeCache && Date.now() - claudeCache.at < 60_000) return claudeCache.value;
  const bin = await which(settings.brain.claudeBin);
  const value: ClaudeStatus = await new Promise((resolve) => {
    if (!bin) return resolve({ found: false, loggedIn: false, detail: "Claude Code isn't installed" });
    execFile(bin, ["auth", "status"], { timeout: 15_000 }, (err, stdout) => {
      try {
        const s = JSON.parse(String(stdout)) as { loggedIn?: boolean; authMethod?: string };
        resolve({ found: true, loggedIn: !!s.loggedIn, detail: s.loggedIn ? `Signed in (${s.authMethod})` : "Not signed in" });
      } catch {
        resolve({ found: true, loggedIn: false, detail: err ? err.message.split("\n")[0] : "Couldn't read status" });
      }
    });
  });
  claudeCache = { at: Date.now(), value };
  return value;
}

// ---------- shared bits

type Tone = "ok" | "warn" | "bad" | "info" | "neutral";
const pill = (tone: Tone, text: string) => html`<span class="pill pill-${tone}">${text}</span>`;
const taskBtn = (kind: string, text: string, opts: { input?: Record<string, unknown>; cls?: string } = {}) =>
  html`<button type="button" class="btn ${opts.cls ?? ""}" data-task="${kind}"${opts.input ? html` data-task-input="${JSON.stringify(opts.input)}"` : ""}>${text}</button>`;

function step(n: number, title: string, status: SafeHtml, body: SafeHtml, actions: SafeHtml): SafeHtml {
  return html`<li class="step">
    <div class="step-num">${n}</div>
    <div class="step-main">
      <div class="step-head"><h2>${title}</h2>${status}</div>
      <div class="step-body">${body}</div>
      <div class="row step-actions">${actions}</div>
    </div>
  </li>`;
}

const issuesBox = () => html`<ul class="issues" data-issues hidden></ul>`;
const plistInstalled = () => existsSync(path.join(os.homedir(), "Library", "LaunchAgents", "com.nuportal.daily.plist"));

// ---------- Setup

export function setupPage(ctx: Ctx, claude: ClaudeStatus): string {
  const resume = existsSync(path.join(ME_DIR, "resume.pdf"));
  const linkedin = existsSync(path.join(ME_DIR, "linkedin.pdf"));
  const linkedinUrl = currentLinkedin();
  const samplesDir = path.join(ME_DIR, "samples");
  const samples = existsSync(samplesDir) ? readdirSync(samplesDir).filter((f) => !f.startsWith(".")) : [];
  const drafts = listDrafts();
  const hasProfile = profileExists();
  const valid = hasProfile && profileValid();
  const answers = safe(() => readAnswers().length, 0);
  const storyFile = readTextForEdit("stories.md");
  const stories = storyFile.source === "file" ? (storyFile.text.match(/^##\s*\[story:/gm) ?? []).length : 0;
  const storiesDrafted = storyFile.source === "draft";
  const session = sessionView(getKv(ctx.db, "session", null));
  const ext = ctx.settings.external;
  const scheduled = plistInstalled();

  const body = html`
  <div class="page-head"><h1>Set up NU Portal</h1><p class="muted">Work down the list. Everything stays on this Mac; nothing is sent to employers from this page.</p></div>
  <div class="task-inline" data-task-log hidden></div>
  <ol class="steps">
    ${step(
      1,
      "Connect Claude",
      claude.loggedIn ? pill("ok", "Connected") : pill("bad", claude.found ? "Not signed in" : "Not installed"),
      html`<p>NU Portal uses your Claude subscription to score jobs and write. ${claude.detail}.</p>`,
      html`${claude.loggedIn ? "" : html`<button type="button" class="btn primary" data-open="claude-login">Sign in to Claude</button>`}
        ${taskBtn("doctor-brain", "Test the connection")}`,
    )}
    ${step(
      2,
      "Add your resume and LinkedIn",
      resume ? pill("ok", linkedinUrl ? "Resume + LinkedIn" : "Resume added") : pill("warn", "Resume needed"),
      html`<p>Your resume (PDF) is required. Your LinkedIn link goes on your profile and into the LinkedIn field on applications. Past cover letters or essays help NU Portal match your voice.</p>
        <ul class="files">
          <li>${resume ? "✓" : "○"} Resume ${resume ? html`<span class="muted">me/resume.pdf</span>` : ""}</li>
          <li>${linkedinUrl ? "✓" : "○"} LinkedIn ${linkedinUrl ? html`<a href="${linkedinUrl}" target="_blank" rel="noopener noreferrer">${linkedinUrl.replace(/^https:\/\/(www\.)?/, "")}</a>` : ""}</li>
          <li>${samples.length ? "✓" : "○"} Writing samples ${samples.length ? html`<span class="muted">${samples.join(", ")}</span>` : ""}</li>
        </ul>
        <form class="form link-form" data-api="/api/linkedin" data-reload>
          <div class="field"><label for="li-url">LinkedIn profile link</label>
            <div class="row"><input id="li-url" name="url" type="url" inputmode="url" placeholder="https://www.linkedin.com/in/your-name" value="${linkedinUrl ?? ""}"><button class="btn" type="submit">Save link</button></div>
          </div>
          ${issuesBox()}
        </form>`,
      html`<label class="btn primary upload">${resume ? "Replace resume" : "Upload resume"}<input type="file" accept="application/pdf" data-upload="resume" hidden></label>
        <label class="btn upload">Writing sample<input type="file" accept=".pdf,.txt,.md" data-upload="sample" multiple hidden></label>
        <label class="btn ghost upload" title="Optional: LinkedIn → More → Save to PDF gives Claude more detail than your resume">LinkedIn PDF${linkedin ? " ✓" : ""} (optional)<input type="file" accept="application/pdf" data-upload="linkedin" hidden></label>
        <button type="button" class="btn ghost" data-open-folder="me">Open folder</button>`,
    )}
    ${step(
      3,
      "Build your profile",
      valid ? pill("ok", "Profile saved") : drafts.length ? pill("info", "Draft ready to review") : pill("warn", hasProfile ? "Needs fixes" : "Not built yet"),
      html`<p>Claude reads your documents and drafts your profile and stories. You review everything before it's used, then fill in what documents can't say: work authorization, co-op details, and what you want.</p>
        ${drafts.length ? html`<p class="flag flag-info">Drafts waiting: ${drafts.join(", ")}.</p>` : ""}`,
      html`${taskBtn("profile-build", hasProfile ? "Rebuild from documents" : "Build from my resume", { cls: resume ? "primary" : "" })}
        ${drafts.length ? html`<a class="btn" href="/drafts">Review drafts</a>` : ""}
        <a class="btn" href="/profile${drafts.includes("profile.yaml") ? "?from=draft" : ""}">Edit profile</a>`,
    )}
    ${step(
      4,
      "Private details",
      privateExists() ? pill("ok", "Saved") : pill("warn", "Not set"),
      html`<p>Birthday, address and voluntary self-ID answers, only for forms that ask. Never sent to the AI.</p>`,
      html`<a class="btn" href="/private">Edit private details</a>`,
    )}
    ${step(
      5,
      "Your answers and voice",
      storiesDrafted
        ? pill("info", "Stories drafted, review them")
        : answers >= 5 && stories >= 3
          ? pill("ok", `${answers} answers · ${stories} stories`)
          : pill("warn", `${answers} answers · ${stories} stories`),
      html`<p>Answers to common questions (sponsorship, start date…), your stories, and how you like to sound. Every letter and answer goes through the humanizer using these.</p>`,
      html`<a class="btn" href="/writing">Edit answers, stories, voice</a>`,
    )}
    ${step(
      6,
      "Try a cover letter",
      pill("neutral", "Optional"),
      html`<p>Paste any posting and see the draft, the humanized version, the checks, and the PDF.</p>`,
      html`<a class="btn" href="/try">Try a letter</a>`,
    )}
    ${step(
      7,
      "Sign in to NUworks",
      html`<span class="pill pill-${session.tone}">${session.text}</span>`,
      html`<p>A Chrome window opens on NUworks. Sign in with your Northeastern account and Duo. When your NUworks dashboard appears, NU Portal saves your session and closes the window for you.</p>`,
      html`${taskBtn("login", "Sign in to NUworks", { cls: "primary" })} ${taskBtn("session-check", "Check sign-in")}`,
    )}
    ${step(
      8,
      "Job-list repo",
      ext.enabled && ext.repos.length ? pill("ok", `${ext.repos.length} repo${ext.repos.length > 1 ? "s" : ""}`) : pill("neutral", "Off"),
      html`<p>Paste a GitHub job list (for example a SimplifyJobs-style repo) in Settings and turn it on.</p>`,
      html`<a class="btn" href="/settings#external">Job-list settings</a> ${ext.repos.map((r) => taskBtn("sources-pull", `Pull ${r.replace(/^https:\/\/github\.com\//, "")}`, { input: { repo: r } }))}`,
    )}
    ${step(
      9,
      "Run it every morning",
      scheduled ? pill("ok", `On · ${ctx.settings.schedule.dailyTime}`) : pill("neutral", "Off"),
      html`<p>Runs the daily search at ${ctx.settings.schedule.dailyTime}${ctx.settings.schedule.weekdaysOnly ? " on weekdays" : ""} (or when your Mac wakes) and keeps this app running.</p>`,
      html`${scheduled ? taskBtn("schedule-uninstall", "Turn off") : taskBtn("schedule-install", "Turn on", { cls: "primary" })} ${taskBtn("daily", "Run now")} ${taskBtn("doctor", "Health check")}`,
    )}
  </ol>`;
  return layout(ctx, { title: "Setup", active: "/setup", body });
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

// ---------- Profile

export function profilePage(ctx: Ctx, fromDraft: boolean): string {
  const { doc, source } = readProfileDoc(fromDraft);
  const groups: [string, string][] = [
    ["identity", "About you"],
    ["education", "School"],
    ["workAuth", "Work authorization"],
    ["targets", "What you want"],
  ];
  const field = (f: (typeof PROFILE_FIELDS)[number]) => {
    const v = getPath(doc, f.path);
    const id = `f-${f.path.replaceAll(".", "-")}`;
    const req = f.required ? html` <span class="req" title="required">*</span>` : "";
    let input: SafeHtml;
    if (f.type === "list") {
      input = html`<textarea id="${id}" name="${f.path}" rows="${Math.min(6, Math.max(2, (Array.isArray(v) ? v.length : 0) + 1))}">${Array.isArray(v) ? v.join("\n") : ""}</textarea>`;
    } else if (f.type === "bool") {
      // Required yes/no questions start unanswered so nothing important defaults to "No".
      const unset = v === undefined && f.default === undefined;
      const yes = v === true || (v === undefined && f.default === true);
      input = html`<select id="${id}" name="${f.path}">${unset ? html`<option value="" selected>Choose…</option>` : ""}<option value="yes"${yes ? raw(" selected") : ""}>Yes</option><option value="no"${!yes && !unset ? raw(" selected") : ""}>No</option></select>`;
    } else if (f.type === "tri") {
      input = html`<select id="${id}" name="${f.path}"><option value="">Prefer not to say</option><option value="yes"${v === true ? raw(" selected") : ""}>Yes</option><option value="no"${v === false ? raw(" selected") : ""}>No</option></select>`;
    } else if (f.type === "multi") {
      const chosen = Array.isArray(v) ? v : (f.options ?? []);
      input = html`<div class="chips">${(f.options ?? []).map((o) => html`<label class="chip"><input type="checkbox" name="${f.path}" value="${o}" data-multi${chosen.includes(o) ? raw(" checked") : ""}><span>${o}</span></label>`)}</div>`;
    } else if (f.options) {
      input = html`<select id="${id}" name="${f.path}"><option value=""></option>${f.options.map((o) => html`<option value="${o}"${String(v ?? "") === o ? raw(" selected") : ""}>${o}</option>`)}</select>`;
    } else {
      input = html`<input id="${id}" name="${f.path}" type="${f.type === "number" || f.type === "int" ? "number" : "text"}"${f.type === "number" ? raw(' step="any"') : ""} value="${v === undefined || v === null ? "" : String(v)}">`;
    }
    return html`<div class="field${f.type === "list" ? " wide" : ""}"><label for="${id}">${f.label}${req}</label>${input}${f.hint ? html`<small class="muted">${f.hint}</small>` : ""}</div>`;
  };
  const body = html`
  <div class="page-head"><h1>Your profile</h1><p class="muted">What NU Portal knows about you. Claude only sees this file (minus email and phone), never your private details.</p></div>
  ${source === "draft" ? html`<div class="flag flag-info">Showing the draft built from your documents. Check every field, fill in the rest, then save.</div>` : ""}
  ${source === "template" ? html`<div class="flag flag-warn">No profile yet. <a href="/setup">Build one from your resume</a> or fill this in by hand.</div>` : ""}
  <form class="panel form" data-api="/api/profile" data-wrap="form" data-after="/setup">
    ${groups.map(
      ([key, title]) => html`<fieldset><legend>${title}</legend><div class="grid">${PROFILE_FIELDS.filter((f) => f.path.startsWith(`${key}.`)).map(field)}</div></fieldset>`,
    )}
    <fieldset>
      <legend>Experience, skills, awards (advanced)</legend>
      <p class="muted small">Edited as YAML. Every item needs a unique id (lowercase-with-dashes); letters cite these ids.</p>
      <textarea class="code" name="advanced" data-top rows="18" spellcheck="false">${advancedYaml(doc)}</textarea>
    </fieldset>
    ${fromDraft ? html`<input type="hidden" name="fromDraft" value="true" data-top data-bool>` : ""}
    ${issuesBox()}
    <div class="row"><button class="btn primary" type="submit">Save profile</button><a class="btn ghost" href="/setup">Back to setup</a></div>
  </form>`;
  return layout(ctx, { title: "Profile", active: "/setup", body });
}

// ---------- Private details

const EEO: Record<string, string[]> = {
  gender: ["Decline to self-identify", "Female", "Male", "Non-binary"],
  race: ["Decline to self-identify", "American Indian or Alaska Native", "Asian", "Black or African American", "Native Hawaiian or Other Pacific Islander", "White", "Two or more races"],
  hispanicLatino: ["Decline to self-identify", "Yes", "No"],
  veteran: ["Decline to self-identify", "I am not a protected veteran", "I identify as one or more of the classifications of protected veteran"],
  disability: ["Decline to self-identify", "No, I do not have a disability", "Yes, I have a disability (or previously had a disability)"],
};
const EEO_LABEL: Record<string, string> = { gender: "Gender", race: "Race", hispanicLatino: "Hispanic or Latino", veteran: "Veteran status", disability: "Disability" };

export function privatePage(ctx: Ctx): string {
  const p = safe(() => readPrivate(), null);
  const a = p?.address;
  const input = (name: string, label: string, value: string | undefined, type = "text", hint = "") =>
    html`<div class="field"><label for="p-${name}">${label}</label><input id="p-${name}" name="${name}" type="${type}" value="${value ?? ""}" autocomplete="off">${hint ? html`<small class="muted">${hint}</small>` : ""}</div>`;
  const body = html`
  <div class="page-head"><h1>Private details</h1><p class="muted">Only used to fill form fields that ask for them. Never sent to the AI, never logged, never committed to GitHub. Don't enter your SSN or passwords anywhere in NU Portal.</p></div>
  <form class="panel form" data-api="/api/private" data-after="/setup">
    <fieldset><legend>Basics</legend><div class="grid">
      ${input("dateOfBirth", "Date of birth", p?.dateOfBirth, "date")}
      ${input("nuid", "NUID", p?.nuid, "text", "only if a form asks")}
    </div></fieldset>
    <fieldset><legend>Address</legend><div class="grid">
      ${input("street", "Street", a?.street)} ${input("city", "City", a?.city)} ${input("state", "State", a?.state)} ${input("zip", "ZIP", a?.zip)} ${input("country", "Country", a?.country ?? "United States")}
    </div></fieldset>
    <fieldset><legend>Voluntary self-identification</legend><p class="muted small">Leave as “Decline” unless you want to share.</p><div class="grid">
      ${Object.entries(EEO).map(
        ([k, opts]) => html`<div class="field"><label for="p-${k}">${EEO_LABEL[k]}</label><select id="p-${k}" name="${k}">${opts.map(
          (o) => html`<option${(p?.eeo as Record<string, string> | undefined)?.[k] === o ? raw(" selected") : ""}>${o}</option>`,
        )}</select></div>`,
      )}
    </div></fieldset>
    <fieldset><legend>Anything else forms ask for</legend><textarea name="other" rows="3" placeholder="Label: value, one per line">${p ? Object.entries(p.other).map(([k, v]) => `${k}: ${v}`).join("\n") : ""}</textarea></fieldset>
    ${issuesBox()}
    <div class="row"><button class="btn primary" type="submit">Save private details</button><a class="btn ghost" href="/setup">Back</a></div>
  </form>`;
  return layout(ctx, { title: "Private details", active: "/setup", body });
}

// ---------- Answers, stories, voice

export function writingPage(ctx: Ctx): string {
  const answers = safe(() => readAnswers(), []);
  const rows = answers.length ? answers : [{ id: "", match: [] as string[], answer: "" }];
  const answerRow = (a: { id: string; match: string[]; answer: string }) => html`<div class="answer-row" data-answer-row>
    <input name="id" value="${a.id}" placeholder="id, e.g. sponsorship" aria-label="id">
    <input name="match" value="${a.match.join(", ")}" placeholder="words in the question, comma separated" aria-label="matches">
    <input name="answer" value="${a.answer}" placeholder="your answer" aria-label="answer">
    <button type="button" class="btn ghost" data-remove-row aria-label="Remove">✕</button>
  </div>`;
  const textForm = (file: TextFile, title: string, help: string, rowsN: number) => {
    const t = readTextForEdit(file);
    return html`<form class="panel form" data-api="/api/text/${file}" data-reload>
    <h2>${title}</h2><p class="muted small">${help}</p>
    ${t.source === "draft" ? html`<p class="flag flag-info">Drafted from your resume. Check every line (only true details), edit anything, then save to start using it.</p>` : ""}
    ${t.source === "empty" && file !== "preferences.md" ? html`<p class="flag flag-warn">Nothing yet. Click “Build from my resume” on <a href="/setup">Setup</a> to draft this, or write your own.</p>` : ""}
    <textarea name="text" rows="${rowsN}" class="code" placeholder="${t.example}">${t.text}</textarea>
    ${issuesBox()}<div class="row"><button class="btn primary" type="submit">${t.source === "draft" ? "Looks right, save" : "Save"}</button></div>
  </form>`;
  };
  const body = html`
  <div class="page-head"><h1>Answers, stories, voice</h1><p class="muted">Your own answers are used word for word before the AI is asked anything.</p></div>
  <form class="panel form" data-answers>
    <h2>Answer bank</h2>
    <p class="muted small">When an application question contains one of the words in the middle column, your answer is used.</p>
    <div class="answer-head"><span>Id</span><span>Question contains</span><span>Your answer</span><span></span></div>
    <div data-answer-rows>${rows.map(answerRow)}</div>
    <template data-answer-template>${answerRow({ id: "", match: [], answer: "" })}</template>
    ${issuesBox()}
    <div class="row"><button type="button" class="btn" data-add-row>Add answer</button><button class="btn primary" type="submit">Save answers</button></div>
  </form>
  ${textForm("stories.md", "Stories", "STAR stories (situation, task, action, result). Keep the heading format ## [story:id] Title. Only true details.", 16)}
  ${textForm("voice.md", "Voice", "How your writing should sound. The humanizer follows this.", 8)}
  ${textForm("preferences.md", "Learned preferences", "What NU Portal has learned you like. Edit freely.", 6)}`;
  return layout(ctx, { title: "Writing", active: "/setup", body });
}

// ---------- Drafts

export function draftsPage(ctx: Ctx): string {
  const drafts = listDrafts();
  const body = html`
  <div class="page-head"><h1>Drafts from your documents</h1><p class="muted">Review each one. Nothing here is used until you accept it.</p></div>
  ${drafts.length ? "" : empty("No drafts waiting. Build one from Setup.")}
  ${drafts.map(
    (d) => html`<section class="panel" data-draft-box>
      <div class="section-head"><h2>${d}</h2>
        <div class="row">${
          d === "profile.yaml"
            ? html`<a class="btn primary" href="/profile?from=draft">Review in the profile editor</a>`
            : html`<button type="button" class="btn primary" data-draft="${d}" data-draft-action="accept">Use this</button>`
        }<button type="button" class="btn ghost" data-draft="${d}" data-draft-action="discard">Discard</button></div>
      </div>
      <pre class="draft">${readDraft(d) ?? ""}</pre>
    </section>`,
  )}`;
  return layout(ctx, { title: "Drafts", active: "/setup", body });
}

// ---------- Settings

export function settingsPage(ctx: Ctx): string {
  const s = ctx.settings;
  const num = (name: string, label: string, value: number, hint = "", min = 0, max?: number) =>
    html`<div class="field"><label for="s-${name}">${label}</label><input id="s-${name}" name="${name}" type="number" min="${min}"${max !== undefined ? html` max="${max}"` : ""} value="${value}">${hint ? html`<small class="muted">${hint}</small>` : ""}</div>`;
  const letters = (name: string, value: string) =>
    html`<div class="field"><label for="s-${name}">Cover letters</label><select id="s-${name}" name="${name}"><option value="required"${value === "required" ? raw(" selected") : ""}>Only when required</option><option value="whenAccepted"${value === "whenAccepted" ? raw(" selected") : ""}>Whenever the posting accepts one</option></select></div>`;
  const adapter = (a: "greenhouse" | "lever" | "ashby", name: string) => {
    const done = cleanSubmits(ctx.db, a);
    const v = s.external.adapters[a];
    return html`<div class="field"><label for="s-${a}">${name}</label><select id="s-${a}" name="external.adapters.${a}">
      <option value="off"${v === "off" ? raw(" selected") : ""}>Off</option>
      <option value="supervised"${v === "supervised" ? raw(" selected") : ""}>Supervised: I confirm each one</option>
      <option value="auto"${v === "auto" ? raw(" selected") : ""}>Automatic${done < GRADUATION ? ` (after ${GRADUATION} supervised)` : ""}</option>
    </select><small class="muted">${done}/${GRADUATION} watched submissions done${done >= GRADUATION ? " · ready for automatic" : ""}</small></div>`;
  };
  const body = html`
  <div class="page-head"><h1>Settings</h1></div>
  <form class="panel form" data-api="/api/settings" data-reload>
    <fieldset><legend>NUworks</legend><div class="grid">
      <div class="field"><label for="s-cycle">Co-op cycle</label><input id="s-cycle" name="cycle.label" value="${s.cycle.label}"><small class="muted">e.g. Spring 2027</small></div>
      ${num("nuworks.weeklyLimit", "Applications per week", s.nuworks.weeklyLimit, "your own limit")}
      ${num("cycle.cap", "Cycle cap", s.cycle.cap, "NUworks allows 100", 1)}
      ${num("cycle.reserve", "Keep in reserve", s.cycle.reserve, "for postings you find yourself")}
      ${num("nuworks.minScore", "Minimum match score", s.nuworks.minScore, "0-100", 0, 100)}
      ${num("nuworks.maxPerEmployer", "Max per employer", s.nuworks.maxPerEmployer, "", 1)}
      ${letters("nuworks.coverLetters", s.nuworks.coverLetters)}
    </div></fieldset>
    <fieldset id="external"><legend>Job-list repos (auto-apply)</legend>
      <label class="check"><input type="checkbox" name="external.enabled" data-bool${s.external.enabled ? raw(" checked") : ""}> Use job-list repos</label>
      <div class="grid">
        <div class="field wide"><label for="s-repos">GitHub repos</label><textarea id="s-repos" name="external.repos" rows="2" placeholder="https://github.com/owner/repo">${s.external.repos.join("\n")}</textarea><small class="muted">one per line</small></div>
        <div class="field"><label for="s-terms">Terms</label><input id="s-terms" name="external.terms" value="${s.external.terms.join(", ")}"><small class="muted">e.g. Spring 2027, Summer 2027</small></div>
        ${num("external.maxPerDay", "Applications per day", s.external.maxPerDay)}
        ${num("external.maxPerCompany", "Max per company", s.external.maxPerCompany, "", 1)}
        ${num("external.postedWithinDays", "Only postings newer than (days)", s.external.postedWithinDays, "", 1)}
        ${num("external.minRelevance", "Minimum relevance", s.external.minRelevance, "0-100", 0, 100)}
        ${letters("external.coverLetters", s.external.coverLetters)}
      </div>
      <h3>Application systems</h3>
      <p class="muted small">Each system must pass ${GRADUATION} applications you watch and confirm before it can run on its own. CAPTCHAs, Workday and other account-based sites always come to you.</p>
      <div class="grid">${adapter("greenhouse", "Greenhouse")}${adapter("lever", "Lever")}${adapter("ashby", "Ashby")}</div>
    </fieldset>
    <fieldset><legend>Schedule</legend><div class="grid">
      <div class="field"><label for="s-time">Daily run time</label><input id="s-time" name="schedule.dailyTime" type="time" value="${s.schedule.dailyTime}"></div>
      <label class="check"><input type="checkbox" name="schedule.weekdaysOnly" data-bool${s.schedule.weekdaysOnly ? raw(" checked") : ""}> Weekdays only</label>
    </div><p class="muted small">After changing the time, turn the schedule off and on again from Setup.</p></fieldset>
    ${issuesBox()}
    <div class="row"><button class="btn primary" type="submit">Save settings</button></div>
  </form>`;
  return layout(ctx, { title: "Settings", active: "/settings", body });
}

// ---------- Tasks

export function tasksPage(ctx: Ctx): string {
  const tasks = ctx.tasks.list();
  const tone = (st: string): Tone => (st === "ok" ? "ok" : st === "failed" ? "bad" : "info");
  const body = html`
  <div class="page-head"><h1>Tasks</h1><p class="muted">Run things and watch their output.</p></div>
  <section class="panel">
    <div class="row wrap">
      ${taskBtn("daily", "Daily run", { cls: "primary" })}
      ${taskBtn("session-check", "Check NUworks sign-in")}
      ${taskBtn("login", "Sign in to NUworks")}
      ${taskBtn("apply-dry", "Practice run (watch it)", { input: { watch: true } })}
      ${taskBtn("report", "Rebuild report")}
      ${taskBtn("doctor", "Health check")}
      ${ctx.settings.external.repos.map((r) => taskBtn("sources-pull", `Pull ${r.replace(/^https:\/\/github\.com\//, "")}`, { input: { repo: r } }))}
    </div>
  </section>
  <div class="tasks-layout">
    <section class="panel">
      <h2>Recent</h2>
      ${tasks.length ? "" : empty("Nothing has run since the app started.")}
      <ul class="list compact task-list">${tasks.map(
        (t) => html`<li><button type="button" class="linklike" data-show-task="${t.id}">${t.label}</button>${pill(tone(t.status), t.status === "running" ? "running" : t.status === "ok" ? "done" : "failed")}<span class="muted small">${new Date(t.startedAt).toLocaleTimeString("en-US", { timeZone: ctx.settings.timezone })}</span></li>`,
      )}</ul>
    </section>
    <section class="panel"><div class="task-inline" data-task-log${tasks.length ? html` data-initial-task="${tasks[0].id}"` : ""}>${tasks.length ? "" : html`<p class="muted">Output appears here.</p>`}</div></section>
  </div>`;
  return layout(ctx, { title: "Tasks", active: "/tasks", body });
}

// ---------- Try a letter

export function tryPage(ctx: Ctx): string {
  const ready = profileValid();
  const body = html`
  <div class="page-head"><h1>Try a cover letter</h1><p class="muted">Paste a posting. You'll get Claude's draft, the humanized version, the checks, and a PDF. Nothing is saved to a job or sent anywhere.</p></div>
  ${ready ? "" : html`<div class="flag flag-warn">Save your profile first (<a href="/setup">Setup</a>); letters are written from it.</div>`}
  <form class="panel form" data-try>
    <div class="grid">
      <div class="field"><label for="t-employer">Company</label><input id="t-employer" name="employer" required></div>
      <div class="field"><label for="t-title">Job title</label><input id="t-title" name="title" required></div>
    </div>
    <div class="field wide"><label for="t-posting">Posting text</label><textarea id="t-posting" name="posting" rows="10" required placeholder="Paste the job description"></textarea></div>
    <div class="field wide"><label for="t-question">Application question (optional)</label><input id="t-question" name="question" placeholder="e.g. Why do you want to work here? Leave empty for a cover letter"></div>
    <div class="row"><button class="btn primary" type="submit"${ready ? "" : raw(" disabled")}>Write it</button><span class="muted small">Takes about a minute.</span></div>
  </form>
  <section class="panel"><div class="task-inline" data-task-log hidden></div></section>`;
  return layout(ctx, { title: "Try a letter", active: "/setup", body });
}
