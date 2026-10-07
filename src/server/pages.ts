import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { LETTERS_DIR, ME_DIR, REPORTS_DIR, SCREENSHOTS_DIR } from "../config/paths.js";
import { type Db, getKv, parseJson } from "../db/db.js";
import { asStrings, buildDailyReport, readHalt, trackOf } from "../report/build.js";
import { daysLeftText, label, NEEDS_YOU_LABEL, pill, scoreBadge, sessionView, trackPill, usd } from "../report/present.js";
import { ago, dayIn, daysBetween, formatDate, formatDateTime, formatLongDay, isDay } from "../core/time.js";
import type { DailyReport, HaltInfo, NeedsYouItem, QueueRow, Track } from "../report/types.js";
import { CLEAR_PHRASE, notifyList } from "../core/halt.js";
import { type Ctx, REASON_TAGS } from "./context.js";
import { html, raw, safeUrl, type SafeHtml } from "./html.js";

type Row = Record<string, unknown>;

const NAV: Array<[string, string]> = [
  ["/", "Today"],
  ["/setup", "Setup"],
  ["/tasks", "Tasks"],
  ["/history", "History"],
  ["/external", "External"],
  ["/settings", "Settings"],
  ["/learning", "Learning"],
  ["/offer", "Offer"],
];

const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

export function jobHref(id: string): string {
  return `/jobs/${encodeURIComponent(id)}`;
}

// Maps a letter PDF path to its dashboard URL, or null if it lives outside LETTERS_DIR.
export function letterHref(p: string): string | null {
  const base = path.resolve(LETTERS_DIR);
  const abs = path.resolve(base, p);
  if (!abs.startsWith(base + path.sep) || !abs.endsWith(".pdf")) return null;
  return `/letters/${path.relative(base, abs).split(path.sep).map(encodeURIComponent).join("/")}`;
}

// Maps a stored screenshot path to its dashboard URL, or null if it lives outside SCREENSHOTS_DIR.
export function screenshotHref(p: string): string | null {
  const base = path.resolve(SCREENSHOTS_DIR);
  const abs = path.resolve(base, p);
  if (!abs.startsWith(base + path.sep)) return null;
  return `/screenshots/${path.relative(base, abs).split(path.sep).map(encodeURIComponent).join("/")}`;
}

export function extLink(url: unknown, text: string): SafeHtml {
  const href = safeUrl(typeof url === "string" ? url : null);
  return href ? html`<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>` : html``;
}

function haltBanner(halt: HaltInfo): SafeHtml {
  return html`<div class="banner banner-bad" role="alert">
    <strong>Halted.</strong> You accepted an offer from ${halt.employer} (${halt.date}). Nothing will be submitted.
    <a href="/offer">See who to notify</a>
  </div>`;
}

export function layout(ctx: Ctx, opts: { title: string; active?: string; body: SafeHtml }): string {
  const halt = readHalt(ctx.db);
  const page = html`<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<meta name="nuportal-token" content="${ctx.token}">
<title>${opts.title} · NU Portal</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="/static/style.css">
<script src="/static/app.js" defer></script>
</head>
<body>
<header class="topbar">
  <div class="topbar-inner">
    <a class="brand" href="/">NU Portal</a>
    <nav aria-label="Main">${NAV.map(
      ([href, text]) => html`<a href="${href}"${opts.active === href ? raw(' aria-current="page"') : ""}>${text}</a>`,
    )}</nav>
  </div>
</header>
${halt ? haltBanner(halt) : ""}
<main class="wrap">${opts.body}</main>
<div class="toast" data-toast role="status" aria-live="polite" hidden></div>
</body>
</html>`;
  return `<!doctype html>\n${page.value}\n`;
}

export function empty(text: string): SafeHtml {
  return html`<p class="empty">${text}</p>`;
}

// ---------- Today

interface LetterRow {
  id: number;
  version: number;
  source: string;
  body: string;
}

function currentLetters(db: Db, jobIds: string[]): Map<string, LetterRow> {
  const out = new Map<string, LetterRow>();
  const stmt = db.prepare(
    "SELECT id, version, source, body FROM writings WHERE job_id = ? AND kind = 'cover_letter' AND is_current = 1 ORDER BY version DESC LIMIT 1",
  );
  for (const id of jobIds) {
    const r = stmt.get(id) as Row | undefined;
    if (r) out.set(id, { id: Number(r.id), version: Number(r.version), source: String(r.source), body: String(r.body) });
  }
  return out;
}

function preview(text: string, max = 220): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function meter(value: number, max: number, high: number): SafeHtml {
  return html`<meter min="0" max="${max}" value="${Math.min(value, max)}" low="${Math.round(high * 0.6)}" high="${high}" optimum="0"></meter>`;
}

function healthBar(r: DailyReport): SafeHtml {
  const s = r.summary;
  const session = sessionView(s.session);
  return html`<section class="health" aria-label="Status">
    <div class="stat">
      <span class="k">Session</span>
      <span class="pill pill-${session.tone}">${session.text}</span>
      <span class="sub">${s.session?.checkedAt ? `checked ${ago(s.session.checkedAt)}` : "run npm run session:check"}</span>
    </div>
    <div class="stat">
      <span class="k">NUworks cap</span>
      <span class="v">${s.capUsed}<small>/${s.cap}</small></span>
      ${meter(s.capUsed, s.cap, s.cap - s.reserve)}
      <span class="sub">${s.reserve} reserved · ${r.pacing.cycleRemaining} left</span>
    </div>
    <div class="stat">
      <span class="k">This week</span>
      <span class="v">${s.weekSubmitted}<small>/${s.weeklyLimit}</small></span>
      ${meter(s.weekSubmitted, s.weeklyLimit, s.weeklyLimit)}
      <span class="sub">${r.pacing.weeklyRemaining} left until Monday</span>
    </div>
    <div class="stat">
      <span class="k">Applied today</span>
      <span class="v">${s.appliedToday.total}</span>
      <span class="sub">${s.appliedToday.nuworks} NUworks · ${s.appliedToday.external} external</span>
    </div>
    <div class="stat">
      <span class="k">Needs you</span>
      <span class="v">${s.needsYouCount}</span>
      <span class="sub">${s.needsYouCount ? "see the list" : "all clear"}</span>
    </div>
  </section>`;
}

function skipPanel(): SafeHtml {
  return html`<div class="skip-panel" data-skip-panel hidden>
    <fieldset class="chips">
      <legend>Why skip?</legend>
      ${REASON_TAGS.map((t) => html`<label class="chip"><input type="checkbox" name="reason" value="${t}"><span>${label(t)}</span></label>`)}
    </fieldset>
    <div class="row">
      <input type="text" name="note" maxlength="500" placeholder="Note (optional)" aria-label="Skip note">
      <button type="button" class="btn danger" data-action="confirm-skip">Skip job</button>
      <button type="button" class="btn ghost" data-action="cancel-skip">Cancel</button>
    </div>
  </div>`;
}

function decisionButtons(): SafeHtml {
  return html`<button type="button" class="btn primary" data-action="approve">Approve <kbd>A</kbd></button>
    <button type="button" class="btn" data-action="skip" aria-expanded="false">Skip <kbd>S</kbd></button>
    <button type="button" class="btn" data-action="defer">Defer <kbd>D</kbd></button>`;
}

function queueCard(q: QueueRow, letter: LetterRow | undefined, tz: string, day: string, writesOptional: boolean): SafeHtml {
  const deadline = q.deadlineAt ? html`${formatDateTime(q.deadlineAt, tz)} <span class="muted">(${daysLeftText(daysBetween(day, dayIn(tz, q.deadlineAt)))})</span>` : "Not listed";
  const meta = [q.employer, q.location, q.modality && q.modality !== "unknown" ? q.modality : null].filter(Boolean).join(" · ");
  const letterId = `letter-${q.jobId}`;
  return html`<article class="card" tabindex="0" data-job-id="${q.jobId}" data-title="${q.title}" aria-label="${q.title} at ${q.employer}">
    <header class="card-head">
      <div class="card-title">
        <h3><a href="${jobHref(q.jobId)}">${q.title}</a></h3>
        <p class="muted">${meta}</p>
      </div>
      ${scoreBadge(q.score)}
    </header>
    <dl class="facts">
      <div><dt>Pay</dt><dd>${q.payText ?? "Not listed"}</dd></div>
      <div><dt>Deadline</dt><dd>${deadline}</dd></div>
      <div><dt>Track</dt><dd>${trackPill(q.track)}${q.term ? html` <span class="muted">${q.term}</span>` : ""}</dd></div>
    </dl>
    ${q.why ? html`<p class="why">${q.why}</p>` : ""}
    ${q.suspectedInjection ? html`<p class="flag flag-bad">This posting may contain text aimed at the AI. Read it yourself before approving.</p>` : ""}
    ${
      q.gaps.length || q.redFlags.length
        ? html`<div class="notes">
      ${q.gaps.length ? html`<div><h4>Gaps</h4><ul>${q.gaps.map((g) => html`<li>${g}</li>`)}</ul></div>` : ""}
      ${q.redFlags.length ? html`<div class="red"><h4>Red flags</h4><ul>${q.redFlags.map((g) => html`<li>${g}</li>`)}</ul></div>` : ""}
    </div>`
        : ""
    }
    ${
      q.coverLetter === "not_accepted" && !letter
        ? html`<p class="muted small doc-note">📄 Resume only: this posting doesn't take a cover letter.</p>`
        : html`<details class="letter"${q.coverLetter === "required" && !letter ? raw(" open") : ""}>
      <summary>
        <span class="summary-label">Cover letter ${q.coverLetter === "required" ? html`<span class="pill pill-warn">required</span> ` : q.coverLetter === "optional" ? html`<span class="pill">optional</span> ` : ""}<span class="muted" data-letter-version>${letter ? `v${letter.version}${letter.source === "edit" ? " · edited" : ""}` : "none yet"}</span></span>
        <span class="preview" data-letter-preview>${letter ? preview(letter.body) : q.coverLetter === "required" || (q.coverLetter === "optional" && writesOptional) ? "Not written yet. NU Portal drafts it on the next daily run, or write one here." : "Optional. Write one here if you like."}</span>
      </summary>
      <label class="sr-only" for="${letterId}">Cover letter text</label>
      <textarea id="${letterId}" name="body" rows="14" spellcheck="true">${letter?.body ?? ""}</textarea>
      <div class="row">
        <button type="button" class="btn" data-action="save-letter">Save as new version</button>
        <span class="muted small" data-letter-status></span>
      </div>
    </details>`
    }
    <div class="actions">
      ${decisionButtons()}
      <span class="spacer"></span>
      ${extLink(q.applyUrl, "Posting ↗")}
    </div>
    ${skipPanel()}
  </article>`;
}

function approvedCounts(db: Db): Record<Track, number> {
  const out: Record<Track, number> = { nuworks: 0, external: 0 };
  const rows = db.prepare("SELECT source, COUNT(*) AS n FROM jobs WHERE status = 'approved' GROUP BY source").all() as Row[];
  for (const r of rows) out[trackOf(String(r.source))] += Number(r.n);
  return out;
}

function applyPanel(ctx: Ctx, halted: boolean): SafeHtml {
  const approved = approvedCounts(ctx.db);
  const tracks: Array<[Track, string]> = [
    ["nuworks", "NUworks"],
    ["external", "External"],
  ];
  return html`<section class="panel" aria-labelledby="apply-h">
    <h2 id="apply-h">Submit approved</h2>
    ${halted ? html`<p class="flag flag-bad">Halted. Apply runs are off.</p>` : ""}
    ${tracks.map(([t, name]) => {
      // Job-list live runs ask you to confirm each supervised application right here.
      const unlocked = t === "external" || getKv<unknown>(ctx.db, `${t}.liveUnlocked`, false) === true;
      const note =
        t === "external"
          ? "Live opens Chrome and fills each form. Before anything is sent you see a screenshot here and click Submit or Skip."
          : unlocked
            ? "Live submits for real, within your limits."
            : "NUworks applying turns on after NUworks is mapped (Phase 2). Approve here, apply by hand for now.";
      return html`<div class="apply-track">
        <div class="apply-head"><strong>${name}</strong><span class="muted">${approved[t]} approved</span></div>
        <div class="row">
          <button type="button" class="btn" data-apply-track="${t}" data-apply-mode="dry-run"${halted ? raw(" disabled") : ""}>Practice run</button>
          <button type="button" class="btn warn" data-apply-track="${t}" data-apply-mode="live"${halted || !unlocked ? raw(" disabled") : ""}>Apply for real</button>
        </div>
        <p class="muted small">${note}</p>
      </div>`;
    })}
    <div class="confirm-panel" data-confirm-panel hidden></div>
    <div class="run-status" data-run-status hidden></div>
  </section>`;
}

function needsYouList(items: NeedsYouItem[]): SafeHtml {
  if (!items.length) return empty("Nothing needs you right now.");
  return html`<ul class="list">${items.map(
    (i) => html`<li>
      ${pill(i.kind, NEEDS_YOU_LABEL[i.kind] ?? label(i.kind))}
      <div class="grow">
        ${i.jobId && i.title ? html`<a class="role" href="${jobHref(i.jobId)}">${i.title}</a>${i.employer ? html` <span class="muted">· ${i.employer}</span>` : ""}` : ""}
        <div class="small">${i.message}</div>
      </div>
      ${extLink(i.applyUrl, "Apply ↗")}
    </li>`,
  )}</ul>`;
}

function summaryPanel(r: DailyReport): SafeHtml {
  const tz = r.timezone;
  const saved = existsSync(path.join(REPORTS_DIR, `${r.day}.html`));
  return html`<section class="panel" aria-labelledby="summary-h">
    <h2 id="summary-h">Today so far</h2>
    ${
      r.appliedToday.length
        ? html`<ul class="list compact">${r.appliedToday.map(
            (a) => html`<li><div class="grow"><a href="${jobHref(a.jobId)}">${a.title}</a> <span class="muted">· ${a.company}</span></div>${trackPill(a.track)}</li>`,
          )}</ul>`
        : empty("No applications sent yet today.")
    }
    <dl class="kv">
      <div><dt>Filtered or skipped</dt><dd>${r.filteredCounts.reduce((n, f) => n + f.count, 0)}</dd></div>
      <div><dt>Employer updates</dt><dd>${r.statusChanges.length}</dd></div>
      <div><dt>Deadlines this week</dt><dd>${r.deadlines.length}</dd></div>
      <div><dt>AI calls</dt><dd>${r.brain.calls} · ${usd(r.brain.costUsd)}</dd></div>
      <div><dt>Warnings / errors</dt><dd>${r.problems.length}</dd></div>
    </dl>
    ${
      r.deadlines.length
        ? html`<h3>Coming up</h3><ul class="list compact">${r.deadlines.slice(0, 5).map(
            (d) => html`<li><div class="grow"><a href="${jobHref(d.jobId)}">${d.title}</a> <span class="muted">· ${d.employer}</span></div><span class="small">${formatDate(d.deadlineAt, tz)}</span></li>`,
          )}</ul>`
        : ""
    }
    ${
      r.problems.length
        ? html`<h3>Latest problems</h3><ul class="list compact">${r.problems.slice(-4).map(
            (p) => html`<li><span class="pill pill-${p.level === "error" ? "bad" : "warn"}">${p.level}</span><div class="grow small">${p.message}</div></li>`,
          )}</ul>`
        : ""
    }
    <p class="small">${saved ? html`<a href="/reports/${r.day}">Open today's saved report</a> · ` : ""}<a href="/history">All reports</a></p>
  </section>`;
}

export function todayPage(ctx: Ctx): string {
  const tz = ctx.settings.timezone;
  const day = dayIn(tz);
  const r = buildDailyReport(ctx.db, day, ctx.settings);
  const letters = currentLetters(ctx.db, r.queue.map((q) => q.jobId));
  const needsSetup = !existsSync(path.join(ME_DIR, "profile.yaml"));
  const body = html`
  <div class="page-head">
    <h1>${formatLongDay(day)}</h1>
  </div>
  ${needsSetup ? html`<div class="banner banner-info" role="note"><strong>Welcome!</strong> NU Portal doesn't know you yet. <a href="/setup">Start setup</a> to upload your resume and build your profile.</div>` : ""}
  ${healthBar(r)}
  <div class="today">
    <section class="queue" aria-labelledby="queue-h">
      <div class="section-head">
        <h2 id="queue-h">Review queue <span class="count" data-queue-count>${r.queue.length}</span></h2>
        <p class="hint">Focus a card, then <kbd>A</kbd> approve · <kbd>S</kbd> skip · <kbd>D</kbd> defer · <kbd>J</kbd>/<kbd>K</kbd> move</p>
      </div>
      <noscript><p class="flag flag-warn">The buttons on this page need JavaScript.</p></noscript>
      ${r.queue.length ? r.queue.map((q) => queueCard(q, letters.get(q.jobId), tz, day, ctx.settings.nuworks.coverLetters === "whenAccepted")) : ""}
      <p class="empty"${r.queue.length ? raw(" hidden") : ""} data-queue-empty>Nothing to review. New matches arrive with the daily run.</p>
    </section>
    <aside class="side">
      ${applyPanel(ctx, Boolean(r.summary.halt))}
      <section class="panel" aria-labelledby="needs-h">
        <h2 id="needs-h">Needs you <span class="count">${r.needsYou.length}</span></h2>
        ${needsYouList(r.needsYou)}
      </section>
      ${summaryPanel(r)}
    </aside>
  </div>`;
  return layout(ctx, { title: "Today", active: "/", body });
}

// ---------- Job detail

function jsonList(v: unknown): string[] {
  return asStrings(parseJson(typeof v === "string" ? v : null, []));
}

function scoreItem(r: Row, tz: string): SafeHtml {
  const matched = jsonList(r.matched);
  const gaps = jsonList(r.gaps);
  const flags = jsonList(r.red_flags);
  return html`<li>
    ${scoreBadge(Number(r.score))}
    <div class="grow">
      <div class="small muted">${s(r.kind)} · ${formatDateTime(String(r.scored_at), tz)}${r.model ? ` · ${s(r.model)}` : ""}${r.prompt_version ? ` · prompt ${s(r.prompt_version)}` : ""}</div>
      <div>${s(r.why)}</div>
      ${Number(r.suspected_injection) === 1 ? html`<p class="flag flag-bad">Suspected prompt injection in the posting.</p>` : ""}
      ${matched.length ? html`<div class="small"><strong>Matched:</strong> ${matched.join(", ")}</div>` : ""}
      ${gaps.length ? html`<div class="small"><strong>Gaps:</strong> ${gaps.join("; ")}</div>` : ""}
      ${flags.length ? html`<div class="small red"><strong>Red flags:</strong> ${flags.join("; ")}</div>` : ""}
    </div>
  </li>`;
}

function prettyJson(text: unknown): string {
  if (typeof text !== "string" || !text) return "";
  const v = parseJson<unknown>(text, text);
  return typeof v === "string" ? v : JSON.stringify(v, null, 2);
}

export function jobPage(ctx: Ctx, id: string): string | null {
  const db = ctx.db;
  const tz = ctx.settings.timezone;
  const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Row | undefined;
  if (!job) return null;
  const scores = db.prepare("SELECT * FROM scores WHERE job_id = ? ORDER BY scored_at DESC, id DESC").all(id) as Row[];
  const decisions = db.prepare("SELECT * FROM decisions WHERE job_id = ? ORDER BY decided_at DESC, id DESC").all(id) as Row[];
  const writings = db
    .prepare("SELECT * FROM writings WHERE job_id = ? ORDER BY kind DESC, question, version DESC, id DESC")
    .all(id) as Row[];
  const app = db.prepare("SELECT * FROM applications WHERE job_id = ?").get(id) as Row | undefined;
  const events = db.prepare("SELECT ts, level, kind, message FROM events WHERE job_id = ? ORDER BY id DESC LIMIT 100").all(id) as Row[];
  const status = String(job.status);
  const decidable = ["queued", "deferred", "skipped"].includes(status);
  const meta = [job.employer, job.location, job.modality && job.modality !== "unknown" ? job.modality : null].filter(Boolean).map(String).join(" · ");
  const fact = (k: string, v: unknown) => (v === null || v === undefined || v === "" ? "" : html`<div><dt>${k}</dt><dd>${v}</dd></div>`);
  const docs = jsonList(job.required_docs);
  const screenshots = app ? jsonList(app.screenshots) : [];

  const body = html`
  <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Today</a> <span aria-hidden="true">/</span> <span>Job</span></nav>
  <div class="page-head">
    <h1>${s(job.title)}</h1>
    <p class="muted">${meta}</p>
    <p class="pills">${pill(status)} ${trackPill(trackOf(String(job.source)))} ${job.status_reason ? html`<span class="muted small">${s(job.status_reason)}</span>` : ""}</p>
  </div>

  ${
    decidable
      ? html`<div class="card card-flat" tabindex="0" data-job-id="${id}" data-title="${s(job.title)}" data-after="reload">
      <div class="actions">${decisionButtons()}</div>
      ${skipPanel()}
    </div>`
      : ""
  }

  <div class="job-grid">
    <section class="panel">
      <h2>Posting</h2>
      <dl class="facts">
        ${fact("Term", job.term)}
        ${fact("Pay", job.pay_text)}
        ${fact("Deadline", job.deadline_at ? formatDateTime(String(job.deadline_at), tz) : null)}
        ${fact("Posted", job.posted_at ? formatDate(String(job.posted_at), tz) : null)}
        ${fact("Apply method", job.apply_method)}
        ${fact("ATS", job.ats)}
        ${fact("Cover letter", label(String(job.cover_letter)))}
        ${fact("Source", job.source)}
        ${fact("Required docs", docs.join(", "))}
        ${fact("First seen", formatDateTime(String(job.first_seen_at), tz))}
      </dl>
      <p>${extLink(job.apply_url, "Open the posting ↗")}</p>
      ${job.qualifications ? html`<h3>Qualifications</h3><pre class="code">${prettyJson(job.qualifications)}</pre>` : ""}
      <h3>Description</h3>
      ${job.description ? html`<div class="prewrap">${s(job.description)}</div>` : empty("No description saved.")}
    </section>

    <div class="stack">
      <section class="panel">
        <h2>Scores</h2>
        ${
          scores.length
            ? html`<ul class="list">${scores.map((r) => scoreItem(r, tz))}</ul>`
            : empty("Not scored yet.")
        }
      </section>

      <section class="panel">
        <h2>Decisions</h2>
        ${
          decisions.length
            ? html`<ul class="list">${decisions.map(
                (d) => html`<li>
                  ${pill(d.decision === "approve" ? "approved" : d.decision === "skip" ? "skipped" : "deferred", s(d.decision))}
                  <div class="grow small">
                    <div class="muted">${s(d.decided_by)} · ${formatDateTime(String(d.decided_at), tz)}${d.score_at_decision !== null ? ` · score ${s(d.score_at_decision)}` : ""}</div>
                    ${jsonList(d.reason_tags).map((t) => html`<span class="pill pill-muted">${label(t)}</span> `)}
                    ${d.note ? html`<div>${s(d.note)}</div>` : ""}
                  </div>
                </li>`,
              )}</ul>`
            : empty("No decisions yet.")
        }
      </section>

      <section class="panel">
        <h2>Application</h2>
        ${
          app
            ? html`<dl class="facts">
            ${fact("Result", pill(String(app.result)))}
            ${fact("Track", trackPill(String(app.track)))}
            ${fact("Via", app.via)}
            ${fact("Started", formatDateTime(String(app.started_at), tz))}
            ${fact("Submitted", app.submitted_at ? formatDateTime(String(app.submitted_at), tz) : null)}
            ${fact("Employer status", app.remote_status ? html`${pill(String(app.remote_status))} <span class="muted small">${formatDateTime(s(app.remote_status_at), tz)}</span>` : null)}
            ${fact("Error", app.error)}
            ${fact("Letter", app.letter_id ? `writing #${s(app.letter_id)}` : null)}
          </dl>
          ${
            screenshots.length
              ? html`<div class="shots">${screenshots.map((p, i) => {
                  const href = screenshotHref(p);
                  return href
                    ? html`<a href="${href}" target="_blank" rel="noopener"><img src="${href}" alt="Screenshot ${i + 1}" loading="lazy"></a>`
                    : html`<span class="small muted">${p}</span>`;
                })}</div>`
              : ""
          }`
            : empty("No application yet.")
        }
      </section>
    </div>
  </div>

  <section class="panel">
    <h2>Writing history</h2>
    ${
      writings.length
        ? writings.map((w) => {
            const lint = parseJson<{ ok?: boolean; problems?: unknown[] } | null>(typeof w.lint === "string" ? w.lint : null, null);
            const problems = asStrings(lint?.problems ?? []);
            return html`<article class="writing${Number(w.is_current) === 1 ? " current" : ""}">
            <header class="writing-head">
              <strong>${w.kind === "cover_letter" ? "Cover letter" : html`Answer: ${s(w.question)}`}</strong>
              <span class="muted small">v${s(w.version)} · ${s(w.source)} · ${formatDateTime(String(w.created_at), tz)}${w.model ? ` · ${s(w.model)}` : ""}</span>
              ${Number(w.is_current) === 1 ? html`<span class="pill pill-accent">current</span>` : ""}
            </header>
            <div class="compare">
              <div><h4>Draft <span class="muted">(before humanizer)</span></h4>${w.draft ? html`<div class="prewrap">${s(w.draft)}</div>` : empty(w.source === "edit" ? "Your edit has no AI draft." : "No draft saved.")}</div>
              <div><h4>Final</h4><div class="prewrap">${s(w.body)}</div></div>
            </div>
            ${problems.length ? html`<p class="flag flag-warn">Lint: ${problems.join("; ")}</p>` : ""}
          </article>`;
          })
        : empty("No cover letters or answers yet.")
    }
  </section>

  <section class="panel">
    <h2>Activity</h2>
    ${
      events.length
        ? html`<ul class="list compact">${events.map(
            (e) => html`<li><span class="mono small muted">${formatDateTime(String(e.ts), tz)}</span><div class="grow small"><span class="mono">${s(e.kind)}</span> ${s(e.message)}</div>${e.level === "warn" || e.level === "error" ? html`<span class="pill pill-${e.level === "error" ? "bad" : "warn"}">${s(e.level)}</span>` : ""}</li>`,
          )}</ul>`
        : empty("No events yet.")
    }
  </section>`;
  return layout(ctx, { title: s(job.title), body });
}

// ---------- History

export function listReportDays(): string[] {
  try {
    return readdirSync(REPORTS_DIR)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.html$/.test(f))
      .map((f) => f.slice(0, 10))
      .filter(isDay)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

export function historyPage(ctx: Ctx): string {
  const tz = ctx.settings.timezone;
  const days = listReportDays();
  const apps = ctx.db
    .prepare(
      `SELECT a.*, j.title, j.employer FROM applications a JOIN jobs j ON j.id = a.job_id
       ORDER BY COALESCE(a.submitted_at, a.started_at) DESC, a.id DESC LIMIT 500`,
    )
    .all() as Row[];
  const body = html`
  <div class="page-head"><h1>History</h1></div>
  <div class="history">
    <section class="panel">
      <h2>Daily reports</h2>
      ${
        days.length
          ? html`<ul class="list compact">${days.map((d) => html`<li><a href="/reports/${d}">${formatLongDay(d)}</a></li>`)}</ul>`
          : empty("No saved reports yet. Run: npm run nup -- report")
      }
    </section>
    <section class="panel">
      <h2>Applications <span class="count">${apps.length}</span></h2>
      ${
        apps.length
          ? html`<div class="table-wrap"><table>
        <thead><tr><th>Role</th><th>Track</th><th>Result</th><th>Sent</th><th>Employer status</th></tr></thead>
        <tbody>${apps.map(
          (a) => html`<tr>
            <td><a class="role" href="${jobHref(String(a.job_id))}">${s(a.title)}</a><div class="muted small">${s(a.employer)}${a.via === "manual" ? " · by hand" : ""}</div></td>
            <td>${trackPill(String(a.track))}</td>
            <td>${pill(String(a.result))}</td>
            <td class="num">${formatDateTime(s(a.submitted_at) || s(a.started_at), tz)}</td>
            <td>${a.remote_status ? pill(String(a.remote_status)) : html`<span class="muted">–</span>`}</td>
          </tr>`,
        )}</tbody>
      </table></div>`
          : empty("No applications yet.")
      }
    </section>
  </div>`;
  return layout(ctx, { title: "History", active: "/history", body });
}

// ---------- External (Track B)

const ADAPTER_TONE: Record<string, string> = { auto: "ok", supervised: "info", off: "muted" };

export function externalPage(ctx: Ctx): string {
  const db = ctx.db;
  const manual = db
    .prepare(
      `SELECT j.id, j.title, j.employer, j.ats, j.apply_url, j.status, j.status_reason, j.updated_at, a.error
       FROM jobs j LEFT JOIN applications a ON a.job_id = j.id
       WHERE j.source <> 'nuworks' AND j.status IN ('needs_manual', 'manual_todo', 'submit_unknown')
       ORDER BY j.deadline_at IS NULL, j.deadline_at, j.updated_at DESC`,
    )
    .all() as Row[];
  const perAts = db
    .prepare(
      `SELECT COALESCE(ats, 'unknown') AS ats, COUNT(*) AS total,
         SUM(status IN ('queued', 'approved')) AS waiting,
         SUM(status IN ('submitted', 'applied_manual')) AS applied,
         SUM(status IN ('needs_manual', 'manual_todo')) AS manual,
         SUM(status IN ('failed', 'submit_unknown')) AS problems
       FROM jobs WHERE source <> 'nuworks' GROUP BY 1 ORDER BY total DESC, ats`,
    )
    .all() as Row[];
  const adapters = ctx.settings.external.adapters as Record<string, string>;
  const unlocked = getKv<unknown>(db, "external.liveUnlocked", false) === true;
  const body = html`
  <div class="page-head">
    <h1>External applications</h1>
    <p class="muted">Postings from GitHub job lists. ${ctx.settings.external.enabled ? "Track B is on." : "Track B is off in settings."} Live submits are ${unlocked ? "unlocked" : "locked"}.</p>
  </div>
  <section class="panel">
    <h2>Apply by hand <span class="count">${manual.length}</span></h2>
    ${
      manual.length
        ? html`<div class="table-wrap"><table>
      <thead><tr><th>Role</th><th>ATS</th><th>Why</th><th></th></tr></thead>
      <tbody>${manual.map(
        (r) => html`<tr>
          <td><a class="role" href="${jobHref(String(r.id))}">${s(r.title)}</a><div class="muted small">${s(r.employer)}</div></td>
          <td>${s(r.ats) || html`<span class="muted">unknown</span>`}</td>
          <td>${pill(String(r.status))}<div class="small">${s(r.status_reason) || s(r.error)}</div></td>
          <td>${extLink(r.apply_url, "Apply ↗")}</td>
        </tr>`,
      )}</tbody>
    </table></div>`
        : empty("Nothing to apply to by hand.")
    }
  </section>
  <section class="panel">
    <h2>By application system</h2>
    ${
      perAts.length
        ? html`<div class="table-wrap"><table>
      <thead><tr><th>ATS</th><th>Mode</th><th class="num">Jobs</th><th class="num">Waiting</th><th class="num">Applied</th><th class="num">By hand</th><th class="num">Problems</th></tr></thead>
      <tbody>${perAts.map(
        (r) => html`<tr>
          <td>${s(r.ats)}</td>
          <td>${adapters[String(r.ats)] ? html`<span class="pill pill-${ADAPTER_TONE[adapters[String(r.ats)]] ?? "muted"}">${adapters[String(r.ats)]}</span>` : html`<span class="muted">manual only</span>`}</td>
          <td class="num">${s(r.total)}</td><td class="num">${s(r.waiting)}</td><td class="num">${s(r.applied)}</td><td class="num">${s(r.manual)}</td><td class="num">${s(r.problems)}</td>
        </tr>`,
      )}</tbody>
    </table></div>`
        : empty("No external postings yet.")
    }
  </section>`;
  return layout(ctx, { title: "External", active: "/external", body });
}

// ---------- Learning

export function learningPage(ctx: Ctx): string {
  const tz = ctx.settings.timezone;
  const open = ctx.db.prepare("SELECT * FROM proposals WHERE status = 'open' ORDER BY created_at DESC, id DESC").all() as Row[];
  const decided = ctx.db
    .prepare("SELECT * FROM proposals WHERE status <> 'open' ORDER BY decided_at DESC, id DESC LIMIT 20")
    .all() as Row[];
  const body = html`
  <div class="page-head">
    <h1>Learning</h1>
    <p class="muted">Suggestions drawn from your decisions and edits. Nothing changes until you accept.</p>
  </div>
  <section class="panel">
    <h2>Open proposals <span class="count">${open.length}</span></h2>
    ${
      open.length
        ? open.map(
            (p) => html`<article class="proposal" data-proposal="${s(p.id)}">
          <header class="writing-head">${pill("open", s(p.kind))}<span class="muted small">${formatDateTime(String(p.created_at), tz)}</span></header>
          <pre class="code">${prettyJson(p.payload)}</pre>
          ${p.evidence ? html`<details><summary>Evidence</summary><pre class="code">${prettyJson(p.evidence)}</pre></details>` : ""}
          <div class="actions">
            <button type="button" class="btn primary" data-proposal-id="${s(p.id)}" data-status="accepted">Accept</button>
            <button type="button" class="btn" data-proposal-id="${s(p.id)}" data-status="rejected">Reject</button>
            <span class="muted small" data-proposal-result></span>
          </div>
        </article>`,
          )
        : empty("No open proposals.")
    }
  </section>
  ${
    decided.length
      ? html`<section class="panel"><h2>Recently decided</h2><ul class="list compact">${decided.map(
          (p) => html`<li>${pill(String(p.status))}<div class="grow small"><strong>${s(p.kind)}</strong> <span class="muted">${formatDateTime(s(p.decided_at), tz)}</span></div></li>`,
        )}</ul></section>`
      : ""
  }`;
  return layout(ctx, { title: "Learning", active: "/learning", body });
}

// ---------- Offer kill switch

interface NotifyEntry {
  employer: string;
  roles: string[];
  statuses: string[];
}

// core/halt.ts returns one row per application; the page shows one row per employer.
function groupNotify(rows: Array<{ employer: string; title: string; status: string }>): NotifyEntry[] {
  const byEmployer = new Map<string, NotifyEntry>();
  for (const r of rows) {
    const key = r.employer.trim().toLowerCase();
    const e = byEmployer.get(key) ?? { employer: r.employer, roles: [], statuses: [] };
    if (!e.roles.includes(r.title)) e.roles.push(r.title);
    if (r.status && !e.statuses.includes(r.status)) e.statuses.push(r.status);
    byEmployer.set(key, e);
  }
  const hot = (e: NotifyEntry) => (e.statuses.some((x) => /offer/i.test(x)) ? 2 : e.statuses.some((x) => /interview/i.test(x)) ? 1 : 0);
  return [...byEmployer.values()].sort((a, b) => hot(b) - hot(a) || a.employer.localeCompare(b.employer));
}

export function offerPage(ctx: Ctx): string {
  const tz = ctx.settings.timezone;
  const halt = readHalt(ctx.db);
  const today = dayIn(tz);
  let body: SafeHtml;
  if (halt) {
    const notify = groupNotify(notifyList(ctx.db));
    const accepted = halt.employer.trim().toLowerCase();
    body = html`
    <div class="page-head">
      <h1>Offer accepted</h1>
      <p class="muted">Halted ${formatDateTime(halt.at, tz)}. Every queued, approved, deferred and to-do job was moved to halted, and apply runs will refuse to start.</p>
    </div>
    <section class="panel">
      <h2>Checklist</h2>
      <ul class="checklist">
        <li><label><input type="checkbox"> Record and accept the offer in NUworks (Student Utilities → My Co-op Job Search → Record an Offer). Required for Spring 2027 co-ops.</label></li>
        <li><label><input type="checkbox"> Tell your co-op coordinator you accepted ${halt.employer}.</label></li>
        <li><label><input type="checkbox"> Withdraw your other NUworks applications.</label></li>
        <li><label><input type="checkbox"> Reply to the other employers below, interviews and offers first.</label></li>
      </ul>
    </section>
    <section class="panel">
      <h2>Employers to notify <span class="count">${notify.length}</span></h2>
      ${
        notify.length
          ? html`<div class="table-wrap"><table>
        <thead><tr><th>Employer</th><th>Roles</th><th>Status</th></tr></thead>
        <tbody>${notify.map(
          (n) => html`<tr>
            <td><strong>${n.employer}</strong>${n.employer.trim().toLowerCase() === accepted ? html` <span class="pill pill-ok">accepted</span>` : ""}</td>
            <td class="small">${n.roles.join("; ")}</td>
            <td>${n.statuses.map((st) => pill(st))}</td>
          </tr>`,
        )}</tbody>
      </table></div>`
          : empty("No recent applications to follow up on.")
      }
    </section>
    <section class="panel narrow">
      <h2>Clear the halt</h2>
      <p class="small muted">Only if this was a mistake. Halted jobs stay halted; requeue them by hand.</p>
      <form class="form" data-form="halt-clear" autocomplete="off">
        <label><span>Type <strong>${CLEAR_PHRASE}</strong> to confirm</span>
          <input type="text" name="confirm" required>
        </label>
        <button type="submit" class="btn danger">Clear halt</button>
      </form>
    </section>`;
  } else {
    body = html`
    <div class="page-head">
      <h1>Accepted an offer?</h1>
      <p class="muted">This is the kill switch. It moves every queued, approved, deferred and to-do job to halted, stops new apply runs, and shows you who to notify.</p>
    </div>
    <section class="panel narrow">
      <form class="form" data-form="halt" autocomplete="off">
        <label>Employer
          <input type="text" name="employer" required maxlength="200" placeholder="Company you accepted">
        </label>
        <label>Date accepted
          <input type="date" name="date" required value="${today}">
        </label>
        <button type="submit" class="btn danger">Stop everything</button>
      </form>
    </section>`;
  }
  return layout(ctx, { title: "Offer", active: "/offer", body });
}

export function notFoundPage(ctx: Ctx, what = "Page"): string {
  return layout(ctx, {
    title: "Not found",
    body: html`<div class="page-head"><h1>${what} not found</h1><p><a href="/">Back to today</a></p></div>`,
  });
}
