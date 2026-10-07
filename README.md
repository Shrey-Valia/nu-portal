# NU Portal

A personal job-search agent for Northeastern co-op students. It learns who you are, finds postings you're eligible for and would actually want, writes cover letters and application answers in your voice, applies, and gives you a daily report of everything it did.

It runs on your Mac, uses your own Claude subscription for the thinking, and keeps your data on your machine.

## What it does

**Track A: NUworks co-op.** NUworks caps you at 100 applications per cycle, so these get spent carefully.
Every morning it:
- syncs your NUworks applications and the cap count;
- finds new co-op postings for your cycle;
- drops anything you're not eligible for (cycle, majors, GPA, citizenship or sponsorship) or don't want (pay, location, avoided companies);
- scores the rest against your profile;
- queues the best few, paced so you send about 20 a week and keep a reserve.

You approve or skip each one on the dashboard (about 2 minutes), and NU Portal applies to the ones you approve.

**Track B: job-list repos.** Point it at a GitHub repo of internship and co-op links (for example a SimplifyJobs-style list). It filters and screens those postings, then applies automatically on **Greenhouse, Lever and Ashby**.
- Each of those systems has to pass 3 submissions you watch before it may run unattended.
- Workday-style sites that need an account, and anything with a CAPTCHA, go on an "apply manually" list.

**Writing.** Every cover letter and written answer goes through the same steps:
1. Claude drafts it from your profile and stories, citing where each fact came from.
2. It goes through the **humanizer** plugin's rules.
3. It's checked for invented numbers, placeholders, links and length.
4. It's saved as a new version you can read and edit.

Letters are attached as PDFs.

**Report.** You get a daily report (HTML) and a local dashboard at `http://127.0.0.1:4317` covering:
- every application with links, scores, the documents and answers sent, and screenshots;
- what was skipped and why;
- what needs you;
- status changes and deadlines;
- the cap and weekly pacing.

A Mac notification tells you when the run is done.

## Guardrails

- **Nothing is sent from NUworks without your approval.** Practice runs are the default, and the first live run is done by you, in a terminal, while you watch.
- **No passwords stored.** You sign in to NUworks yourself (SSO + Duo). NU Portal only keeps the browser session, in `.auth/`.
- **Offer-accepted kill switch.** Northeastern lets you accept one offer, and reneging can cost you co-op eligibility. One click (or `npm run offer -- accept`) stops both tracks and lists the employers to notify.
- **It never makes things up.** Letter claims must cite your profile, and any question it can't answer truthfully is held for you.
- **No CAPTCHA bypassing, no account creation, no stealth tricks.** It stops and flags instead.
- **Posting text is treated as untrusted.** Hidden text is stripped, and the AI calls have no tools.
- **Your data stays local.**
  - `me/`, `data/`, `.auth/` and `config/settings.yaml` are gitignored, and a pre-commit hook blocks personal details.
  - Your profile and the postings do go to Anthropic when Claude reads them, through your subscription.
  - `me/private.yaml` (birthday, address and similar) is never sent to the AI. It's only used to fill in form fields that ask for it.

## Setup

You need macOS, Node.js 22.13+, Google Chrome, and Claude Code (your Claude subscription).

```bash
git clone https://github.com/Shrey-Valia/nu-portal.git && cd nu-portal
npm install                 # also turns on the privacy pre-commit hook
npm run app -- install      # adds "NU Portal" to ~/Applications (Launchpad, Spotlight, Dock)
```

Open **NU Portal** (or run `npm start`) and follow the **Setup** page. Everything is point-and-click:

1. **Connect Claude:** one button opens the sign-in.
2. **Add your documents:** upload your resume PDF, LinkedIn PDF (LinkedIn → More → Save to PDF), and any past cover letters.
3. **Build your profile:** Claude drafts it from your documents. You review every field and fill in work authorization, co-op details, and what you want.
4. **Private details:** birthday, address, and voluntary self-ID, only for forms that ask. Never sent to the AI.
5. **Answers, stories, voice:** your answers to common questions and how you like to sound.
6. **Try a letter:** paste a posting to see the draft, the humanized version, the checks, and the PDF.
7. **Sign in to NUworks:** a Chrome window opens for Northeastern SSO + Duo.
8. **Job-list repo:** paste a GitHub job list in Settings.
9. **Run it every morning:** one button turns on the 8:30 weekday schedule.

Then use **Today** each morning: approve or skip matches, and click **Apply for real**. For job-list applications, Chrome fills each form while you watch, and nothing is sent until you look at the screenshot and click **Submit**.

The app is a local web page served from your Mac (http://127.0.0.1:4317). Only this computer can reach it.

## Commands

Everything below is also available from the app; the commands are there if you prefer a terminal.

| Command | What it does |
| --- | --- |
| `npm start` | Open the app (starts it if needed) |
| `npm run app -- install` | Install the NU Portal app icon (`uninstall` removes it) |
| `npm run profile:build` | Draft your profile from your resume, LinkedIn PDF, and samples |
| `npm run doctor` | Checks setup. `-- --brain` also tests Claude, `-- --session` tests NUworks, `-- --launchd` runs the checks from inside launchd |
| `npm run login` / `session:check` | Sign in to NUworks / check the saved session |
| `npm run profile:check` | What NU Portal knows about you, and what's missing |
| `npm run letter:sample -- …` | Draft and humanize a letter (or `--question` answer) for a pasted posting |
| `npm run daily` | The morning run (`--fixture`, `--no-external`, `--no-nuworks`, `--no-letters`) |
| `npm run serve` | The dashboard at http://127.0.0.1:4317 |
| `npm run report -- --day YYYY-MM-DD` | Rebuild a daily report |
| `npm run apply -- --track external --mode dry-run --headed` | Fill applications without submitting. `--mode live` sends them; you type SUBMIT and confirm each one |
| `npm run sources:pull -- owner/name` | Download a job-list repo and count its listings by term |
| `npm run offer -- accept --employer "Acme"` | Kill switch (`status`, `clear`) |
| `npm run schedule -- install` | Install the launchd schedule (`uninstall` removes it) |
| `npm run recon` | Phase 2: open NUworks for read-only mapping with Claude Code's `/recon` |
| `npm test` / `npm run typecheck` | Tests / types |

## How it's built

TypeScript on Node 22, run with `tsx`. It uses `node:sqlite` for storage, Playwright driving your installed Chrome, and zod for every schema. The AI is headless Claude Code (`claude -p --json-schema … --tools "" --safe-mode`) using your subscription.

```
src/core/      job states, filters, pacing, dedupe, sanitizer, kill switch, locks
src/brain/     claude -p backend, humanizer, prompts (score, letter, answer, relevance)
src/writing/   draft → humanize → check pipeline, answer bank
src/pipeline/  daily run, NUworks steps, job-list steps, external apply
src/nuworks/   browser, session check, adapter (live after recon; fixture for tests)
src/sources/   GitHub job-list parsing (Simplify listings.json + README tables)
src/ats/       Greenhouse / Lever / Ashby form readers and fillers
src/report/    daily report        src/server/  local dashboard
```

The project MCP servers in `.mcp.json` (Playwright, Chrome DevTools and their `recon-*` versions) are for building and mapping with Claude Code. Context7 (current library docs) and Vercel are installed at user level.

## Roadmap

- [x] **Phase 0, foundations:** database, settings, session check, doctor, safety rails
- [x] **Phase 1, know you:** profile, `/interview`, the writing pipeline with the humanizer, letter PDFs
- [x] **Daily pipeline:** filters, scoring, 20/week pacing, queue, letters, report, dashboard, kill switch, schedule
- [x] **Job-list ingestion** and Greenhouse/Lever/Ashby adapters with the supervised-first rule
- [ ] **Phase 2, NUworks recon:** map Symplicity read-only and implement the live NUworks adapter
- [ ] **Phase 5, NUworks apply:** practice run, then rehearsal, then live
- [ ] **Learning loop:** weekly reflection proposals and outcome tracking

## Disclaimer

A personal productivity tool, not affiliated with Northeastern University, Symplicity, or any job site. Use it within each site's terms and Northeastern's co-op policies. Only apply to jobs you would accept.

## License

MIT
