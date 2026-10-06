import path from "node:path";
import { html, raw, safeUrl, type SafeHtml } from "../server/html.js";
import { daysLeftText, label, NEEDS_YOU_LABEL, pill, scoreBadge, sessionView, trackPill, usd } from "./present.js";
import { formatDate, formatDateTime, formatLongDay, formatTime } from "../core/time.js";
import type { DailyReport, NeedsYouItem } from "./types.js";

// Self-contained: one inline <style>, no scripts, no external requests, so the
// file reads the same opened from disk or served by the dashboard.
export const REPORT_CSS = `
:root{color-scheme:light dark;--bg:#f6f6f3;--surface:#fff;--surface-2:#f0f0ec;--text:#1c1d1f;--muted:#66676d;--border:#e2e2dc;
--accent:#2d6a5a;--accent-soft:#e1efea;--ok:#2e7a4d;--ok-soft:#e2f2e8;--warn:#93600a;--warn-soft:#fbefd6;--bad:#b0302a;--bad-soft:#fbe4e1;
--info:#2f5d99;--info-soft:#e4ecf8;--font:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
@media (prefers-color-scheme:dark){:root{--bg:#131416;--surface:#1b1c1f;--surface-2:#232428;--text:#e9e9ec;--muted:#9c9da4;--border:#2e2f34;
--accent:#6cc3a8;--accent-soft:#1d3a32;--ok:#73cf95;--ok-soft:#1c3526;--warn:#e9b45a;--warn-soft:#3b2d14;--bad:#f08a80;--bad-soft:#3d1f1c;
--info:#8db4ec;--info-soft:#1d2a3d}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 var(--font);-webkit-text-size-adjust:100%}
.wrap{max-width:980px;margin:0 auto;padding:28px 16px 64px}
h1{font-size:1.6rem;line-height:1.25;margin:.15rem 0 .25rem;letter-spacing:-.01em}
h2{font-size:1.05rem;margin:0 0 .75rem}
a{color:var(--accent)}
.eyebrow{margin:0;font-size:.78rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--accent)}
.muted{color:var(--muted)}.small{font-size:.85rem}
section{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:18px 18px 14px;margin:16px 0}
.banner{background:var(--bad-soft);border-color:var(--bad);color:var(--text)}
.banner strong{color:var(--bad)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;background:none;border:0;padding:0}
.tile{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 16px}
.tile .k{font-size:.78rem;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.tile .v{font-size:1.6rem;font-weight:650;line-height:1.2;margin:.2rem 0 .1rem;font-variant-numeric:tabular-nums}
.tile .v small{font-size:.95rem;color:var(--muted);font-weight:500}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:0 -4px}
table{width:100%;min-width:560px;border-collapse:collapse;font-size:.9rem}
td a{white-space:nowrap}
th{text-align:left;font-size:.74rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:600;padding:6px 10px;border-bottom:1px solid var(--border);white-space:nowrap}
td{padding:10px;border-bottom:1px solid var(--border);vertical-align:top}
tr:last-child td{border-bottom:0}
td.num{font-variant-numeric:tabular-nums;white-space:nowrap}
.role{font-weight:600}
.why{color:var(--muted);font-size:.84rem;margin-top:2px;max-width:46ch}
.pill{display:inline-block;padding:1px 9px;border-radius:999px;font-size:.76rem;font-weight:600;white-space:nowrap;background:var(--surface-2);color:var(--muted)}
.pill-ok{background:var(--ok-soft);color:var(--ok)}.pill-warn{background:var(--warn-soft);color:var(--warn)}
.pill-bad{background:var(--bad-soft);color:var(--bad)}.pill-info{background:var(--info-soft);color:var(--info)}
.pill-accent{background:var(--accent-soft);color:var(--accent)}
.score{display:inline-block;min-width:2.2em;text-align:center;padding:1px 6px;border-radius:6px;font-weight:700;font-variant-numeric:tabular-nums;background:var(--surface-2);color:var(--muted)}
.score-ok{background:var(--ok-soft);color:var(--ok)}.score-info{background:var(--info-soft);color:var(--info)}.score-warn{background:var(--warn-soft);color:var(--warn)}
ul.list{list-style:none;margin:0;padding:0}
ul.list li{padding:10px 0;border-bottom:1px solid var(--border);display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap}
ul.list li:last-child{border-bottom:0}
.grow{flex:1 1 240px;min-width:0}
.empty{color:var(--muted);margin:0 0 4px}
.split{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;background:none;border:0;padding:0}
.split>section{margin:0}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.82rem}
footer{color:var(--muted);font-size:.8rem;text-align:center;margin-top:28px}
`.trim();

function empty(text: string): SafeHtml {
  return html`<p class="empty">${text}</p>`;
}

function link(url: string | null, text = "Open posting"): SafeHtml {
  const href = safeUrl(url);
  return href ? html`<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>` : html``;
}

function needsYouList(items: NeedsYouItem[], tz: string): SafeHtml {
  if (!items.length) return empty("Nothing needs you right now.");
  return html`<ul class="list">
    ${items.map(
      (i) => html`<li>
        ${pill(i.kind, NEEDS_YOU_LABEL[i.kind] ?? label(i.kind))}
        <div class="grow">
          ${i.title ? html`<div class="role">${i.title}${i.employer ? html` <span class="muted">· ${i.employer}</span>` : ""}</div>` : ""}
          <div class="small">${i.message}</div>
          ${i.at ? html`<div class="small muted">${formatDateTime(i.at, tz)}</div>` : ""}
        </div>
        ${link(i.applyUrl, "Apply link")}
      </li>`,
    )}
  </ul>`;
}

export function renderReportHtml(report: DailyReport): string {
  const tz = report.timezone;
  const s = report.summary;
  const session = sessionView(s.session);
  const page = html`<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>NU Portal report · ${report.day}</title>
<style>${raw(REPORT_CSS)}</style>
</head>
<body>
<main class="wrap">
  <header>
    <p class="eyebrow">NU Portal · Daily report</p>
    <h1>${formatLongDay(report.day)}</h1>
    <p class="muted small">Generated ${formatDateTime(report.generatedAt, tz)} · times in ${tz}</p>
  </header>

  ${
    s.halt
      ? html`<section class="banner"><strong>Halted.</strong> You accepted an offer from ${s.halt.employer} on ${s.halt.date}. Nothing will be submitted until the halt is cleared.</section>`
      : ""
  }

  <section class="tiles" aria-label="Summary">
    <div class="tile"><div class="k">NUworks cap</div><div class="v">${s.capUsed}<small> / ${s.cap}</small></div><div class="small muted">${s.reserve} reserved · ${report.pacing.cycleRemaining} left${s.cycle ? html` · ${s.cycle.label}` : ""}</div></div>
    <div class="tile"><div class="k">This week</div><div class="v">${s.weekSubmitted}<small> / ${s.weeklyLimit}</small></div><div class="small muted">${report.pacing.weeklyRemaining} left · week of ${formatDate(`${s.weekStart}T12:00:00Z`, "UTC")}</div></div>
    <div class="tile"><div class="k">Applied today</div><div class="v">${s.appliedToday.total}</div><div class="small muted">${s.appliedToday.nuworks} NUworks · ${s.appliedToday.external} external</div></div>
    <div class="tile"><div class="k">Review queue</div><div class="v">${s.queueSize}</div><div class="small muted">waiting for approve or skip</div></div>
    <div class="tile"><div class="k">Needs you</div><div class="v">${s.needsYouCount}</div><div class="small muted">manual steps and checks</div></div>
    <div class="tile"><div class="k">Session</div><div class="v"><span class="pill pill-${session.tone}">${session.text}</span></div><div class="small muted">${s.session?.checkedAt ? `checked ${formatDateTime(s.session.checkedAt, tz)}` : "no check recorded"}</div></div>
  </section>

  <section>
    <h2>Applied today</h2>
    ${
      report.appliedToday.length
        ? html`<div class="scroll"><table>
      <thead><tr><th>Role</th><th>Location</th><th>Track</th><th>ATS</th><th>Score</th><th>Submitted</th><th>Writing</th><th></th></tr></thead>
      <tbody>${report.appliedToday.map(
        (a) => html`<tr>
          <td><div class="role">${a.title}</div><div class="muted small">${a.company}${a.via === "manual" ? " · applied by hand" : ""}</div>${a.why ? html`<div class="why">${a.why}</div>` : ""}</td>
          <td>${a.location ?? ""}</td>
          <td>${trackPill(a.track)}</td>
          <td>${a.ats ?? ""}</td>
          <td>${scoreBadge(a.score)}</td>
          <td class="num">${formatTime(a.submittedAt, tz)}</td>
          <td class="small">${a.letterId ? html`letter <span class="mono">#${a.letterId}</span>` : html`<span class="muted">no letter</span>`}${a.answerIds.length ? html`<br>${a.answerIds.length} answer${a.answerIds.length === 1 ? "" : "s"} <span class="mono">${a.answerIds.map((id) => `#${id}`).join(" ")}</span>` : ""}${a.screenshots.length ? html`<br><span class="muted" title="${a.screenshots.join("\n")}">${a.screenshots.length} screenshot${a.screenshots.length === 1 ? "" : "s"}: ${a.screenshots.map((p) => path.basename(p)).join(", ")}</span>` : ""}</td>
          <td>${link(a.applyUrl, "Posting")}</td>
        </tr>`,
      )}</tbody>
    </table></div>`
        : empty("No applications went out today.")
    }
  </section>

  <section>
    <h2>Needs you</h2>
    ${needsYouList(report.needsYou, tz)}
  </section>

  <section>
    <h2>Review queue <span class="muted">(${report.queue.length})</span></h2>
    ${
      report.queue.length
        ? html`<div class="scroll"><table>
      <thead><tr><th>Deadline</th><th>Role</th><th>Location</th><th>Pay</th><th>Score</th></tr></thead>
      <tbody>${report.queue.map(
        (q) => html`<tr>
          <td class="num">${q.deadlineAt ? formatDate(q.deadlineAt, tz) : html`<span class="muted">none</span>`}</td>
          <td><div class="role">${q.title}</div><div class="muted small">${q.employer} ${trackPill(q.track)}</div>${q.why ? html`<div class="why">${q.why}</div>` : ""}</td>
          <td>${q.location ?? ""}</td>
          <td>${q.payText ?? ""}</td>
          <td>${scoreBadge(q.score)}</td>
        </tr>`,
      )}</tbody>
    </table></div>`
        : empty("The queue is empty.")
    }
  </section>

  <section>
    <h2>Deadlines in the next 7 days</h2>
    ${
      report.deadlines.length
        ? html`<div class="scroll"><table>
      <thead><tr><th>When</th><th>Role</th><th>Status</th></tr></thead>
      <tbody>${report.deadlines.map(
        (d) => html`<tr>
          <td class="num">${formatDateTime(d.deadlineAt, tz)}<div class="muted small">${daysLeftText(d.daysLeft)}</div></td>
          <td><div class="role">${d.title}</div><div class="muted small">${d.employer}</div></td>
          <td>${pill(d.status)}</td>
        </tr>`,
      )}</tbody>
    </table></div>`
        : empty("No deadlines this week for queued or approved jobs.")
    }
  </section>

  <div class="split">
    <section>
      <h2>Status changes</h2>
      ${
        report.statusChanges.length
          ? html`<ul class="list">${report.statusChanges.map(
              (c) => html`<li>${pill(c.remoteStatus)}<div class="grow"><div class="role">${c.title}</div><div class="muted small">${c.company} · ${formatTime(c.at, tz)}</div></div></li>`,
            )}</ul>`
          : empty("No employer updates today.")
      }
    </section>
    <section>
      <h2>Filtered out today</h2>
      ${
        report.filteredCounts.length
          ? html`<ul class="list">${report.filteredCounts.map(
              (f) => html`<li>${pill(f.status)}<div class="grow small">${f.reason ?? "no reason recorded"}</div><strong class="num">${f.count}</strong></li>`,
            )}</ul>`
          : empty("Nothing was filtered or skipped today.")
      }
    </section>
  </div>

  <div class="split">
    <section>
      <h2>Pacing</h2>
      <ul class="list">
        <li><div class="grow">NUworks left this week</div><strong>${report.pacing.weeklyRemaining}</strong></li>
        <li><div class="grow">NUworks left this cycle <span class="muted small">(cap ${report.pacing.cap} − used ${report.pacing.used} − reserve ${report.pacing.reserve})</span></div><strong>${report.pacing.cycleRemaining}</strong></li>
        <li><div class="grow">Ready for the queue <span class="muted small">(above the bar, waiting for a slot)</span></div><strong>${report.pacing.ready}</strong></li>
        <li><div class="grow">AI calls today <span class="muted small">(${report.brain.runs} run${report.brain.runs === 1 ? "" : "s"})</span></div><strong>${report.brain.calls} · ${usd(report.brain.costUsd)}</strong></li>
      </ul>
    </section>
    <section>
      <h2>Warnings and errors</h2>
      ${
        report.problems.length
          ? html`<ul class="list">${report.problems.map(
              (p) => html`<li><span class="pill pill-${p.level === "error" ? "bad" : "warn"}">${p.level}</span><div class="grow small"><span class="mono">${p.kind}</span> ${p.message}<div class="muted">${formatTime(p.ts, tz)}${p.jobId ? html` · <span class="mono">${p.jobId}</span>` : ""}</div></div></li>`,
            )}</ul>`
          : empty("A quiet day: no warnings or errors.")
      }
    </section>
  </div>

  <footer>NU Portal · report for ${report.day}</footer>
</main>
</body>
</html>`;
  return `<!doctype html>\n${page.value}\n`;
}
