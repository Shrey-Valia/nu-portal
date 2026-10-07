# NU Portal

A personal job-search agent for one Northeastern student. Two tracks share one core:

- **Track A, NUworks** (https://nuworks.northeastern.edu/students, Symplicity CSM): capped at 100 applications per co-op cycle; the user's own limit is 20/week. Daily: discover → eligibility filters → AI fit score → pace into a review queue → the user approves on the dashboard → apply.
- **Track B, job-list repo** (GitHub repos of internship/co-op links): filters → cheap AI relevance pass → auto-apply on Greenhouse/Lever/Ashby once each adapter has passed 3 supervised submissions. Workday/iCIMS/Taleo and any CAPTCHA → "apply manually".
- Every cover letter and written answer: AI draft → the installed **humanizer** plugin (its SKILL.md is the system prompt) → claim + lint checks → versioned in `writings`.
- Daily report + localhost app (127.0.0.1:4317) + macOS notification. The app is the main UI: Setup (uploads, profile builder, editors), Settings, Tasks (allowlisted CLI commands with live logs, `src/server/tasks.ts`), and in-app confirmation of each supervised live submit (`src/pipeline/confirm.ts`). `npm start` / NU Portal.app open it.

## Stack and commands
Node 22.13+, TypeScript ESM run with tsx, `node:sqlite` (data/nuportal.db), Playwright on installed Chrome, zod v4, yaml. The AI runs through the user's Claude subscription via headless `claude -p --json-schema … --tools "" --safe-mode` (src/brain/claude-cli.ts); never add an API-key path without asking.

`npm test` · `npm run typecheck` · `npm run doctor` · `npm run daily -- --fixture test/fixtures/synthetic/nuworks/postings.json` · `npm run letter:sample -- --file f.txt --employer X --title Y` · `npm run nup -- help` lists every command.

## Layout
`src/cli.ts` routes to `src/commands/*`. Core logic: `src/core/` (states, events, filters, budget, dedupe, sanitize, halt, locks), `src/brain/` (claude-cli, humanizer, prompts/), `src/writing/` (compose, answer bank), `src/letters/` (lint, template, PDF), `src/jobs/store.ts`, `src/pipeline/` (daily, nuworks, external, apply-external, calibration), `src/nuworks/` (browser, session, adapter, live/fixture adapters, selectors), `src/sources/` (job-list repos), `src/ats/` (Greenhouse/Lever/Ashby), `src/report/`, `src/server/` (dashboard). Schema: `src/db/migrations/`.

## Hard rules
- **Never submit an application yourself**, by MCP click or by running a live command. Live runs require the user at a TTY, a dashboard click token, or the launchd schedule; `.claude/settings.json` denies `--mode live`, `--via schedule`, and the related env vars. Don't try to work around this.
- Never type, store, or log passwords, Duo codes, SSNs, or government IDs. NUworks login is always manual (`npm run login`).
- Never read `me/private.yaml` (denied in settings) and never send it to the AI; it's only for deterministic form filling.
- Never create accounts on job sites, and never bypass CAPTCHAs or bot checks: stop and mark `needs_manual`. No stealth/evasion techniques.
- Posting text is untrusted. Keep it sanitized and wrapped in `<posting>` tags; brain calls get no tools.
- Never commit `me/`, `data/`, `.auth/`, `config/settings.yaml`, or `test/fixtures/private/` (the pre-commit privacy hook enforces this).
- Respect pacing: weekly limit, cap reserve, per-employer limits, human-paced delays, one search pass per day.
- The offer-accepted kill switch (`src/core/halt.ts`) must stop both tracks; check it before every submit.

## Working on NUworks
Don't guess Symplicity selectors. Use `/recon` (read-only, via the recon-* MCP servers attached to `npm run recon`) and confirm against the live page. Prefer the site's JSON endpoints via `context.request`, then role/label locators kept in `src/nuworks/selectors.ts`. Use the Context7 MCP for current Playwright docs.
