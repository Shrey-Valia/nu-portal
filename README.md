# NU Portal

An auto-apply assistant for Northeastern University's **NUworks** co-op and job portal.

Applying to co-ops means scrolling hundreds of postings, opening each one, and clicking through the same application form again and again. NU Portal does the repetitive part for you. It finds postings that match your profile, queues them for you to review, and fills out and submits the applications you approve, using the resume and cover letter already in your NUworks account.

> **Status:** early setup. The repo, browser tooling, and NUworks login are in place. Scraping, matching, and applying come next (see [Roadmap](#roadmap)).

## How it works

```
 login ──▶ discover ──▶ match ──▶ review ──▶ apply ──▶ track
  you      scrape        score      you       fill +     log every
  sign in  NUworks       against    approve   submit     application
  once     postings      profile    or skip   approved
```

1. **Login.** You sign in to NUworks yourself in a real Chrome window (Northeastern SSO + Duo). The session cookies are saved locally in `.auth/`. NU Portal never sees or stores your password.
2. **Discover.** It reads the NUworks job search results and saves each posting (title, employer, location, description, deadline, how to apply) to `data/`.
3. **Match.** It scores each posting against `config/profile.json`: target roles, required and preferred keywords, locations, and companies to skip.
4. **Review.** You see the matches ranked by score and approve or skip each one. Nothing is submitted without your approval.
5. **Apply.** For approved postings, it opens the application, attaches your NUworks documents, and submits. It runs in dry-run mode by default, which fills everything in and stops before the final submit.
6. **Track.** Every application is logged with a timestamp, so you never apply twice and can see where you stand.

## Guardrails

- **You approve every submit.** There's a review step and a dry-run default, and each run stops after `maxApplicationsPerRun`.
- **No stored credentials.** You log in by hand, and only the browser session is kept, in the gitignored `.auth/` folder.
- **Your data stays local.** `config/profile.json`, `documents/`, `data/`, and `.auth/` are all gitignored.
- **Only apply where you'd accept.** Northeastern's co-op process expects you to follow through on interviews and offers, so keep your filters tight.
- **Slow and human-paced.** Actions are rate-limited so the tool doesn't hammer NUworks.

## Setup

Requirements: Node.js 20+ and Google Chrome.

```bash
git clone https://github.com/Shrey-Valia/nu-portal.git
cd nu-portal
npm install
cp config/profile.example.json config/profile.json   # then edit it
npm run login                                         # sign in to NUworks once
```

## MCP servers (for building with Claude Code)

`.mcp.json` registers two browser MCP servers for this project. Claude Code uses them to inspect NUworks pages and map selectors while the scraper and form filler are being built:

| Server | What it's for |
| --- | --- |
| [`playwright`](https://github.com/microsoft/playwright-mcp) | Drive a browser, read the accessibility tree, prototype the scrape and apply flows |
| [`chrome-devtools`](https://github.com/ChromeDevTools/chrome-devtools-mcp) | Inspect the DOM, network requests, and console on NUworks pages |

The [Vercel MCP](https://vercel.com/docs/mcp/vercel-mcp) (`https://mcp.vercel.com`) is installed globally, for deploying the tracker dashboard later.

The first time you open Claude Code in this folder, approve the project MCP servers when prompted. Then run `/mcp` to sign in to Vercel.

## Roadmap

- [x] **Phase 0: Foundation.** Repo, MCP servers, manual NUworks login with a saved session
- [ ] **Phase 1: Discover.** Map the NUworks job search page and scrape postings to `data/jobs.json`
- [ ] **Phase 2: Match.** Keyword scoring against your profile, with optional LLM scoring and tailored cover-letter drafts
- [ ] **Phase 3: Review.** A CLI queue to approve or skip matches
- [ ] **Phase 4: Apply.** Fill and submit NUworks applications (dry-run by default) and flag postings that redirect to outside sites like Workday or Greenhouse
- [ ] **Phase 5: Track.** An application log, plus an optional private dashboard on Vercel

## Project layout

```
.mcp.json                   Project MCP servers (Playwright, Chrome DevTools)
config/profile.example.json Template for your job preferences
src/config.ts               Paths, NUworks URL, profile loader
src/login.ts                Manual login that saves the session to .auth/
```

## Disclaimer

This is a personal productivity tool. It is not affiliated with Northeastern University or Symplicity. Use it responsibly and within NUworks' terms of use.

## License

MIT
