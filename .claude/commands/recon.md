---
description: Phase 2 — map NUworks (read-only) and implement the live NUworks adapter
---

Goal: learn exactly how NUworks (Symplicity CSM) works for this student so `src/nuworks/live-adapter.ts` can be implemented against confirmed facts, not guesses.

## Setup
The user runs `npm run recon` in a terminal first. That opens their logged-in Chrome with remote debugging on 127.0.0.1:9222. Attach with the `recon-playwright` or `recon-devtools` MCP servers (they connect to that browser). If neither can connect, ask the user to start `npm run recon`.

## Rules
- Read-only. Use navigation, snapshots, screenshots, and network request listings. Clicking, typing, uploading, and script evaluation ask the user for approval; only request them to reveal information (open a filter panel, expand a posting), never to change anything.
- Never click Apply/Submit/Withdraw/Upload/Save yourself. When you need to see the apply dialog, ask the user to open it and to cancel afterwards.
- Never record or repeat the student's personal data (name, NUID, email, documents) in files. `docs/recon/nuworks-map.md` describes structure only.
- Fixtures go in `test/fixtures/private/` (gitignored). Synthetic, PII-free fixtures for committed tests go in `test/fixtures/synthetic/nuworks/`.

## What to find out (write each answer into docs/recon/nuworks-map.md)
1. Session: the URL and a stable element that only appear when signed in; what the signed-out page looks like. Update `SESSION` in `src/nuworks/selectors.ts`.
2. Job search: how to get the co-op postings for the student's cycle. Does the SPA call JSON endpoints (list them from the network log, e.g. `/api/v2/jobs...`)? Request method, query parameters (cycle, keywords, page size, pagination), auth headers/cookies needed. Prefer these over DOM scraping. If a read-only endpoint uses POST, record its path for `allowPost` in the read-only guard.
3. Posting detail: fields available (title, employer, location, modality, cycle/term, pay, deadline, description, qualifications such as majors/levels/GPA/citizenship, required documents, cover letter required/optional, apply on NUworks vs employer site + external URL).
4. Applications list: where it lives, fields (job id, status values), and whether NUworks shows the 100-application cap counter.
5. Documents: where the approved resume is listed and how approval status shows; whether uploaded cover letters need coordinator approval; document limits and name length limits. This decides whether per-application letters are possible.
6. Apply flow (user opens it, you only look): dialog fields, how documents are chosen, screening questions, what "submitted" confirmation looks like, whether opening the dialog creates a draft.

## Then implement
- `src/nuworks/selectors.ts` and `src/nuworks/live-adapter.ts` (search, detail, applications, resumeStatus) using `context.request` against the JSON endpoints where possible (cookies come from the persistent profile), role/label locators otherwise.
- Zod schemas for every JSON response you rely on, so a site change fails loudly.
- A read-only `nuworks:smoke` command that runs session check + one search page + one detail + applications with the read-only guard on.
- Tests against synthetic fixtures. Run `npm test` and `npm run typecheck`.
